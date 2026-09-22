// Transform must only ever read the snapshot extract wrote. A half-written, hand-edited or
// old-format snapshot would give a model that looks fine and is wrong.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { REQUIRED_RAW_FILES, SNAPSHOT_FORMAT, readSnapshot } from '../src/lib/snapshot.mjs';
import { writeJson } from '../src/lib/util.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migrator-snapshot-'));
after(() => fs.rm(root, { recursive: true, force: true }));

let counter = 0;
async function makeSnapshot({ format = SNAPSHOT_FORMAT, skip = [], manifest = true } = {}) {
    const dir = path.join(root, `snap-${++counter}`);
    const files = {};
    for (const name of REQUIRED_RAW_FILES.filter(n => !skip.includes(n))) {
        const rows = [{ name }];
        files[name] = { rows: 1, sha256: await writeJson(path.join(dir, 'raw', `${name}.json`), rows) };
    }
    if (manifest) await writeJson(path.join(dir, 'manifest.extract.json'), { stage: 'extract', snapshotFormat: format, files });
    else await fs.mkdir(dir, { recursive: true });
    return dir;
}

describe('readSnapshot', () => {
    test('returns every table listed in a complete, unchanged snapshot', async () => {
        const { raw, manifest } = await readSnapshot(await makeSnapshot());
        assert.deepEqual(Object.keys(raw).toSorted(), REQUIRED_RAW_FILES.toSorted());
        assert.deepEqual(raw.products, [{ name: 'products' }]);
        assert.equal(manifest.snapshotFormat, SNAPSHOT_FORMAT);
    });

    test('refuses a folder without manifest and names the snapshot', async () => {
        const dir = await makeSnapshot({ manifest: false });
        await assert.rejects(readSnapshot(dir), new RegExp(`Snapshot ${path.basename(dir)}: manifest.extract.json is missing.*Re-run extract`));
    });

    test('refuses an old snapshot without a format and tells to re-run extract', async () => {
        const dir = await makeSnapshot({ format: null });
        await assert.rejects(readSnapshot(dir), /snapshot format 1, transform needs format 2.*Re-run extract/);
    });

    test('refuses a manifest that lacks a required table', async () => {
        const dir = await makeSnapshot({ skip: ['product_category_tree'] });
        await assert.rejects(readSnapshot(dir), /the manifest lists no product_category_tree\. Re-run extract/);
    });

    test('refuses a listed file that is missing', async () => {
        const dir = await makeSnapshot();
        await fs.rm(path.join(dir, 'raw', 'tax_rules.json'));
        await assert.rejects(readSnapshot(dir), /raw\/tax_rules\.json is listed in the manifest but missing/);
    });

    test('refuses a file whose content changed after extract', async () => {
        const dir = await makeSnapshot();
        await fs.writeFile(path.join(dir, 'raw', 'products.json'), '[{"name":"edited"}]', 'utf8');
        await assert.rejects(readSnapshot(dir), /raw\/products\.json does not match the sha256/);
    });
});
