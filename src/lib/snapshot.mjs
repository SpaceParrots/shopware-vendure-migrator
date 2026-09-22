// The contract between extract and transform: which raw files a snapshot has and how transform
// checks that it reads exactly what extract wrote.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './util.mjs';

/**
 * Raised to 2 when extract gained product_category_tree, tax_rules.active_from,
 * currencies.item_rounding, languages.translation_code and source_identity.utc_now.
 */
export const SNAPSHOT_FORMAT = 2;

/** Raw tables transform reads. Every one must be listed in the manifest. */
export const REQUIRED_RAW_FILES = [
    'languages', 'currencies', 'sales_channels', 'sales_channel_countries', 'countries', 'country_translations',
    'taxes', 'tax_rules', 'products', 'product_translations', 'product_options', 'product_properties',
    'product_categories', 'product_category_tree', 'product_media', 'product_visibilities',
    'product_configurator_settings', 'product_price_summary', 'rules', 'property_groups',
    'property_group_translations', 'property_group_options', 'property_group_option_translations',
    'manufacturers', 'manufacturer_translations', 'categories', 'category_translations', 'media',
    'media_translations', 'seo_urls', 'source_identity',
];

/**
 * Reads a snapshot for transform after checking it against its extract manifest: the manifest
 * exists, has the current format, lists every required table, and every listed file exists with
 * the recorded sha256.
 * @param {string} snapshotDir
 * @returns {Promise<{ manifest: object, raw: Record<string, unknown[]> }>} raw has one entry per manifest file.
 * @throws {Error} Naming the snapshot, when any check fails or a file is not valid JSON.
 */
export async function readSnapshot(snapshotDir) {
    const name = path.basename(snapshotDir);
    const fail = message => new Error(`Snapshot ${name}: ${message}`);
    const rerun = 'Re-run extract to create a new snapshot.';

    const manifestText = await fs.readFile(path.join(snapshotDir, 'manifest.extract.json'), 'utf8').catch(err => {
        if (err.code === 'ENOENT') throw fail(`manifest.extract.json is missing, so the extract did not finish or this is not a snapshot folder. ${rerun}`);
        throw err;
    });
    const manifest = JSON.parse(manifestText);
    if (manifest.snapshotFormat !== SNAPSHOT_FORMAT) {
        throw fail(`was written in snapshot format ${manifest.snapshotFormat ?? 1}, transform needs format ${SNAPSHOT_FORMAT} (new tables and columns). ${rerun}`);
    }
    const files = manifest.files ?? {};
    const missing = REQUIRED_RAW_FILES.filter(f => !files[f]);
    if (missing.length) throw fail(`the manifest lists no ${missing.join(', ')}. ${rerun}`);

    const raw = {};
    for (const [file, { sha256: recorded }] of Object.entries(files)) {
        const text = await fs.readFile(path.join(snapshotDir, 'raw', `${file}.json`), 'utf8').catch(err => {
            if (err.code === 'ENOENT') throw fail(`raw/${file}.json is listed in the manifest but missing. ${rerun}`);
            throw err;
        });
        if (sha256(text) !== recorded) throw fail(`raw/${file}.json does not match the sha256 in manifest.extract.json; the file was changed after extract. ${rerun}`);
        raw[file] = JSON.parse(text);
    }
    return { manifest, raw };
}
