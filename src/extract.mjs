// Stage 1: raw, consistent snapshot of the catalogue-relevant Shopware tables.
// Everything runs on ONE connection inside a consistent-snapshot transaction, so all
// files describe the same moment even if the shop keeps taking writes. Every query has an
// ORDER BY on the primary key, so the same database state always gives byte-identical files.
import mysql from 'mysql2/promise';
import path from 'node:path';
import { SHOPWARE } from './config.mjs';
import { SALES_QUERIES } from './extract/sales-queries.mjs';
import { SNAPSHOT_FORMAT } from './lib/snapshot.mjs';
import { log, writeJson } from './lib/util.mjs';

const LIVE = `UNHEX('${SHOPWARE.LIVE_VERSION}')`;
const hex = col => `LOWER(HEX(${col}))`;

// name -> SQL. Versioned tables are filtered on the live version, including in joins, so the
// version columns of a primary key are constant and left out of the ORDER BY.
const QUERIES = {
    // translation_code is the locale Shopware uses for content; locale is for number and date
    // formats (LanguageDefinition, BaseSalesChannelContextFactory::getLanguageInfo).
    languages: `SELECT ${hex('l.id')} id, l.name, ${hex('l.parent_id')} parent_id, lo.code locale, tc.code translation_code
        FROM language l JOIN locale lo ON lo.id = l.locale_id LEFT JOIN locale tc ON tc.id = l.translation_code_id
        ORDER BY ${hex('l.id')}`,

    currencies: `SELECT ${hex('id')} id, iso_code, factor, item_rounding FROM currency ORDER BY ${hex('id')}`,

    // Active channels first, so the first storefront in the file is the one transform migrates.
    sales_channels: `SELECT ${hex('sc.id')} id, ${hex('sc.type_id')} type_id, ${hex('sc.currency_id')} currency_id,
            ${hex('sc.language_id')} language_id, ${hex('sc.navigation_category_id')} navigation_category_id,
            ${hex('sc.customer_group_id')} customer_group_id, cg.display_gross, sc.active
        FROM sales_channel sc JOIN customer_group cg ON cg.id = sc.customer_group_id
        ORDER BY sc.active DESC, ${hex('sc.id')}`,

    sales_channel_countries: `SELECT ${hex('sales_channel_id')} sales_channel_id, ${hex('country_id')} country_id
        FROM sales_channel_country ORDER BY ${hex('sales_channel_id')}, ${hex('country_id')}`,

    countries: `SELECT ${hex('id')} id, iso, active, position FROM country ORDER BY ${hex('id')}`,
    country_translations: `SELECT ${hex('country_id')} country_id, ${hex('language_id')} language_id, name
        FROM country_translation ORDER BY ${hex('country_id')}, ${hex('language_id')}`,

    taxes: `SELECT ${hex('id')} id, name, tax_rate, position FROM tax ORDER BY ${hex('id')}`,
    tax_rules: `SELECT ${hex('tr.id')} id, ${hex('tr.tax_id')} tax_id, ${hex('tr.country_id')} country_id, tr.tax_rate,
            tr.active_from, trt.technical_name type
        FROM tax_rule tr JOIN tax_rule_type trt ON trt.id = tr.tax_rule_type_id
        ORDER BY ${hex('tr.id')}`,

    products: `SELECT ${hex('id')} id, ${hex('parent_id')} parent_id, product_number, active,
            ${hex('tax_id')} tax_id, ${hex('product_manufacturer_id')} manufacturer_id, price, stock,
            available_stock, is_closeout, ean, weight, width, height, length,
            ${hex('product_media_id')} cover_product_media_id, child_count
        FROM product WHERE version_id = ${LIVE} ORDER BY ${hex('id')}`,

    product_translations: `SELECT ${hex('product_id')} product_id, ${hex('language_id')} language_id,
            name, description, meta_title, meta_description, keywords
        FROM product_translation WHERE product_version_id = ${LIVE}
        ORDER BY ${hex('product_id')}, ${hex('language_id')}`,

    product_options: `SELECT ${hex('product_id')} product_id, ${hex('property_group_option_id')} option_id
        FROM product_option WHERE product_version_id = ${LIVE}
        ORDER BY ${hex('product_id')}, ${hex('property_group_option_id')}`,

    product_properties: `SELECT ${hex('product_id')} product_id, ${hex('property_group_option_id')} option_id
        FROM product_property WHERE product_version_id = ${LIVE}
        ORDER BY ${hex('product_id')}, ${hex('property_group_option_id')}`,

    product_categories: `SELECT ${hex('product_id')} product_id, ${hex('category_id')} category_id
        FROM product_category WHERE product_version_id = ${LIVE} AND category_version_id = ${LIVE}
        ORDER BY ${hex('product_id')}, ${hex('category_id')}`,

    // categoriesRo: every assigned category plus all its ancestors, written by Shopware's
    // ProductCategoryDenormalizer. The storefront listing filters on it.
    product_category_tree: `SELECT ${hex('product_id')} product_id, ${hex('category_id')} category_id
        FROM product_category_tree WHERE product_version_id = ${LIVE} AND category_version_id = ${LIVE}
        ORDER BY ${hex('product_id')}, ${hex('category_id')}`,

    product_media: `SELECT ${hex('id')} id, ${hex('product_id')} product_id, ${hex('media_id')} media_id, position
        FROM product_media WHERE version_id = ${LIVE} AND product_version_id = ${LIVE} ORDER BY ${hex('id')}`,

    product_visibilities: `SELECT ${hex('product_id')} product_id, ${hex('sales_channel_id')} sales_channel_id, visibility
        FROM product_visibility WHERE product_version_id = ${LIVE} ORDER BY ${hex('id')}`,

    product_configurator_settings: `SELECT ${hex('product_id')} product_id, ${hex('property_group_option_id')} option_id,
            price IS NOT NULL has_price_override
        FROM product_configurator_setting WHERE version_id = ${LIVE} AND product_version_id = ${LIVE}
        ORDER BY ${hex('id')}`,

    product_price_summary: `SELECT ${hex('product_id')} product_id, ${hex('rule_id')} rule_id, COUNT(*) tiers
        FROM product_price WHERE product_version_id = ${LIVE} GROUP BY product_id, rule_id
        ORDER BY ${hex('product_id')}, ${hex('rule_id')}`,

    rules: `SELECT ${hex('id')} id, name, priority FROM rule ORDER BY ${hex('id')}`,

    property_groups: `SELECT ${hex('id')} id, display_type, sorting_type, filterable, visible_on_product_detail_page
        FROM property_group ORDER BY ${hex('id')}`,
    property_group_translations: `SELECT ${hex('property_group_id')} group_id, ${hex('language_id')} language_id, name, position
        FROM property_group_translation ORDER BY ${hex('property_group_id')}, ${hex('language_id')}`,
    property_group_options: `SELECT ${hex('id')} id, ${hex('property_group_id')} group_id, color_hex_code, ${hex('media_id')} media_id
        FROM property_group_option ORDER BY ${hex('id')}`,
    property_group_option_translations: `SELECT ${hex('property_group_option_id')} option_id, ${hex('language_id')} language_id,
            name, position
        FROM property_group_option_translation ORDER BY ${hex('property_group_option_id')}, ${hex('language_id')}`,

    // No link column: 6.7.x moved it to product_manufacturer_translation, and nothing reads it.
    manufacturers: `SELECT ${hex('id')} id, ${hex('media_id')} media_id
        FROM product_manufacturer WHERE version_id = ${LIVE} ORDER BY ${hex('id')}`,
    manufacturer_translations: `SELECT ${hex('product_manufacturer_id')} manufacturer_id, ${hex('language_id')} language_id, name
        FROM product_manufacturer_translation WHERE product_manufacturer_version_id = ${LIVE}
        ORDER BY ${hex('product_manufacturer_id')}, ${hex('language_id')}`,

    categories: `SELECT ${hex('id')} id, ${hex('parent_id')} parent_id, ${hex('after_category_id')} after_category_id,
            level, active, visible, type, product_assignment_type, ${hex('product_stream_id')} product_stream_id,
            ${hex('media_id')} media_id
        FROM category WHERE version_id = ${LIVE} ORDER BY ${hex('id')}`,
    category_translations: `SELECT ${hex('category_id')} category_id, ${hex('language_id')} language_id,
            name, description, meta_title, meta_description
        FROM category_translation WHERE category_version_id = ${LIVE}
        ORDER BY ${hex('category_id')}, ${hex('language_id')}`,

    // Only media a product actually references; the rest is not catalogue data.
    media: `SELECT DISTINCT ${hex('m.id')} id, m.path, m.file_name, m.file_extension, m.mime_type, m.file_size, m.private
        FROM media m JOIN product_media pm ON pm.media_id = m.id AND pm.version_id = ${LIVE}
        ORDER BY id`,
    media_translations: `SELECT ${hex('mt.media_id')} media_id, ${hex('mt.language_id')} language_id, mt.alt, mt.title
        FROM media_translation mt WHERE mt.media_id IN (SELECT media_id FROM product_media WHERE version_id = ${LIVE})
        ORDER BY ${hex('mt.media_id')}, ${hex('mt.language_id')}`,

    seo_urls: `SELECT ${hex('foreign_key')} foreign_key, ${hex('language_id')} language_id,
            ${hex('sales_channel_id')} sales_channel_id, route_name, seo_path_info
        FROM seo_url WHERE is_canonical = 1 AND is_deleted = 0
          AND route_name IN ('frontend.detail.page', 'frontend.navigation.page')
        ORDER BY ${hex('id')}`,

    // utc_now is the snapshot's own clock, in the format and time zone of Shopware's datetime
    // columns (UTC), so transform can tell which tax rules were active at extract time.
    source_identity: `SELECT VERSION() mysql_version, COUNT(*) migrations,
            MAX(creation_timestamp) newest_migration_timestamp, UTC_TIMESTAMP(3) utc_now FROM migration`,

    ...SALES_QUERIES,
};

/**
 * Reads every table in QUERIES inside one read-only consistent-snapshot transaction and writes
 * raw/<name>.json plus manifest.extract.json (row counts, sha256 per file, snapshot format).
 * @param {{ source: { host: string, port: number, user: string, password: string, database: string, label: string } }} config
 * @param {string} snapshotDir New snapshot folder.
 * @returns {Promise<object>} The manifest.
 * @throws {Error} When the connection or a query fails, or a file cannot be written. No manifest is
 *   written then, so transform refuses the half-written snapshot.
 */
export async function extract(config, snapshotDir) {
    const conn = await mysql.createConnection({
        host: config.source.host,
        port: config.source.port,
        user: config.source.user,
        password: config.source.password,
        database: config.source.database,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
    });
    const files = {};
    const startedAt = new Date().toISOString();
    let identity;
    try {
        await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        for (const [name, sql] of Object.entries(QUERIES)) {
            const [rows] = await conn.query(sql);
            const hash = await writeJson(path.join(snapshotDir, 'raw', `${name}.json`), rows);
            files[name] = { rows: rows.length, sha256: hash };
            if (name === 'source_identity') identity = rows[0];
            log(`extract ${name}: ${rows.length}`);
        }
        await conn.query('COMMIT');
    } finally {
        await conn.end();
    }
    const manifest = {
        stage: 'extract',
        snapshotFormat: SNAPSHOT_FORMAT,
        startedAt,
        finishedAt: new Date().toISOString(),
        source: { label: config.source.label, host: config.source.host, database: config.source.database, identity },
        files,
    };
    await writeJson(path.join(snapshotDir, 'manifest.extract.json'), manifest);
    return manifest;
}
