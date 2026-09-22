// Stage 6: prove the result, not just the presence of records. Every variant is compared
// field by field with the intermediate model; collections are compared by membership.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBindings } from './lib/bindings.mjs';
import { log, readJson, writeJson } from './lib/util.mjs';
import { VendureClient } from './lib/vendure-client.mjs';

const QUEUES = ['apply-collection-filters', 'update-search-index', 'send-email', 'clean-sessions'];
// RETRYING jobs run again, so the queue has not drained while any is left.
export const ACTIVE_JOB_STATES = ['PENDING', 'RUNNING', 'RETRYING'];
const JOB_POLL_MS = 5000;
const FAILED_JOB_EXAMPLES = 10;
// The repository root, so the recorded commit is the migrator's and not the caller's cwd's.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Jobs per queue; created since `since` when given, else all jobs in Vendure's job list. */
async function jobTotalsByQueue(client, since) {
    const out = {};
    for (const queue of QUEUES) {
        const filter = since ? { queueName: { eq: queue }, createdAt: { after: since } } : { queueName: { eq: queue } };
        const { jobs } = await client.gql(
            `query($filter: JobFilterParameter!) { jobs(options: { filter: $filter, take: 1 }) { totalItems } }`,
            { filter },
        );
        out[queue] = jobs.totalItems;
    }
    return out;
}

/**
 * Waits until no job is PENDING, RUNNING or RETRYING.
 * @returns {Promise<number>} Milliseconds waited.
 * @throws {Error} When jobs are still active after waitMs.
 */
export async function waitForJobs(client, waitMs, pollMs = JOB_POLL_MS) {
    const t0 = Date.now();
    for (;;) {
        const { jobs } = await client.gql(
            `query($states: [String!]!) { jobs(options: { filter: { state: { in: $states } }, take: 1 }) { totalItems } }`,
            { states: ACTIVE_JOB_STATES },
        );
        if (jobs.totalItems === 0) return Date.now() - t0;
        if (Date.now() - t0 >= waitMs) {
            throw new Error(`${jobs.totalItems} jobs still pending, running or retrying after ${Math.round(waitMs / 1000)} s; is the Vendure worker running?`);
        }
        log(`verify: waiting for ${jobs.totalItems} jobs`);
        await new Promise(r => setTimeout(r, pollMs));
    }
}

/** FAILED jobs, created since `since` when given. */
export async function failedJobs(client, since) {
    const filter = since ? { state: { eq: 'FAILED' }, createdAt: { after: since } } : { state: { eq: 'FAILED' } };
    const { jobs } = await client.gql(
        `query($filter: JobFilterParameter!, $take: Int!) { jobs(options: { filter: $filter, take: $take }) {
            totalItems items { id queueName createdAt error } } }`,
        { filter, take: FAILED_JOB_EXAMPLES },
    );
    return { total: jobs.totalItems, examples: jobs.items };
}

async function allVariants(client) {
    const out = [];
    for (let skip = 0; ; skip += 100) {
        const { productVariants } = await client.gql(
            `query($skip: Int!) { productVariants(options: { take: 100, skip: $skip }) { totalItems items {
                id sku enabled price priceWithTax currencyCode stockOnHand
                taxCategory { id name } product { id } options { id } } } }`,
            { skip },
        );
        out.push(...productVariants.items);
        if (out.length >= productVariants.totalItems || !productVariants.items.length) return out;
    }
}

/**
 * Compares every model offer with the Vendure variant bound to it.
 * @param {object} model
 * @param {import('./lib/bindings.mjs').Bindings} bindings
 * @param {object[]} variants Vendure variants with the fields allVariants() reads.
 * @returns {Record<'missing'|'sku'|'price'|'tax'|'options'|'enabled'|'stock'|'product', object[]>}
 */
export function compareVariants(model, bindings, variants) {
    const byId = new Map(variants.map(v => [String(v.id), v]));
    const mismatches = { missing: [], sku: [], price: [], tax: [], options: [], enabled: [], stock: [], product: [] };
    for (const family of model.families) {
        const productId = bindings.get('product', family.sourceId, 'product');
        for (const o of family.offers) {
            const v = byId.get(bindings.get('product', o.sourceId, 'variant'));
            if (!v) { mismatches.missing.push(o.sku); continue; }
            if (v.sku !== o.sku) mismatches.sku.push({ expected: o.sku, actual: v.sku });
            if (String(v.product.id) !== String(productId)) mismatches.product.push(o.sku);
            // The channel's mode decides which price the shop shows: gross is priceWithTax, net is
            // price. The other one Vendure derives from the tax rate.
            const expected = model.pricesIncludeTax ? o.priceGrossMinor : o.priceNetMinor;
            const actual = model.pricesIncludeTax ? v.priceWithTax : v.price;
            if (actual !== expected) mismatches.price.push({ sku: o.sku, expected, actual, price: v.price, priceWithTax: v.priceWithTax });
            // Compared by id: a tax category renamed in Vendure or two with one name would pass a name check.
            const expectedTax = bindings.get('tax', o.taxSourceId, 'taxCategory') ?? null;
            const actualTax = v.taxCategory ? String(v.taxCategory.id) : null;
            if (expectedTax === null || actualTax !== expectedTax) {
                const name = model.taxCategories.find(t => t.sourceId === o.taxSourceId)?.name ?? null;
                mismatches.tax.push({ sku: o.sku, expected: expectedTax, expectedName: name, actual: actualTax, actualName: v.taxCategory?.name ?? null });
            }
            const expectedOptions = o.optionSourceIds.map(id => bindings.get('productOption', `${family.sourceId}|${id}`, 'option') ?? null).sort();
            const actualOptions = v.options.map(x => String(x.id)).sort();
            if (JSON.stringify(expectedOptions) !== JSON.stringify(actualOptions)) mismatches.options.push({ sku: o.sku, expectedOptions, actualOptions });
            if (v.enabled !== o.enabled) mismatches.enabled.push(o.sku);
            if (v.stockOnHand !== o.stockOnHand) mismatches.stock.push({ sku: o.sku, expected: o.stockOnHand, actual: v.stockOnHand });
        }
    }
    return mismatches;
}

/**
 * Variant count of every collection with members against the model's listing membership. A
 * collection without a binding is a mismatch; Vendure is not asked about it.
 * @returns {Promise<object[]>} One entry per collection that differs.
 */
export async function compareMembership(model, bindings, client) {
    const membership = [];
    for (const col of model.collections.filter(x => x.offerSourceIds.length)) {
        const expected = new Set(col.offerSourceIds).size;
        const name = col.names[model.defaultLanguageCode] ?? Object.values(col.names)[0];
        const id = bindings.get('category', col.sourceId, 'collection');
        if (!id) {
            membership.push({ category: col.sourceId, name, expected, actual: null, reason: 'collection not bound' });
            continue;
        }
        const { collection } = await client.gql(
            `query($id: ID!) { collection(id: $id) { productVariants(options: { take: 1 }) { totalItems } } }`,
            { id },
        );
        const actual = collection?.productVariants.totalItems ?? null;
        if (actual !== expected) membership.push({ category: col.sourceId, name, expected, actual, ...(collection ? {} : { reason: 'collection not in Vendure' }) });
    }
    return membership;
}

/**
 * Product names per language of the model against Vendure, for every language a product has an
 * authored name in.
 * @returns {Promise<Record<string, object[]>>} Mismatches per language code.
 */
export async function compareTranslations(model, bindings, client) {
    const out = {};
    for (const languageCode of model.languageCodes) {
        out[languageCode] = [];
        for (const family of model.families.filter(f => f.names[languageCode])) {
            const expected = family.names[languageCode];
            const id = bindings.get('product', family.sourceId, 'product');
            if (!id) { out[languageCode].push({ sku: family.sku, expected, actual: null, reason: 'product not bound' }); continue; }
            const { product } = await client.gql(`query($id: ID!) { product(id: $id) { name } }`, { id }, { languageCode });
            if (product?.name !== expected) out[languageCode].push({ sku: family.sku, expected, actual: product?.name ?? null });
        }
    }
    return out;
}

function migratorCommit() {
    const git = args => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        let commit = git(['rev-parse', '--short', 'HEAD']);
        if (git(['status', '--porcelain', '--', 'src'])) commit += '+dirty';
        return commit;
    } catch {
        return 'unknown';
    }
}

/**
 * Compares Vendure with the snapshot's model and writes the report.
 *
 * Side effects: reads bindings.json and every snapshot's load journal read-only; writes
 * `<snapshot>/verify-report.json` and `<snapshot>/report.md`. Changes nothing in Vendure.
 *
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {string} snapshotDir Snapshot holding model.json, gaps.json, decisions.json and
 *   manifest.extract.json.
 * @param {{ client?: VendureClient }} [deps] A replacement client for tests.
 * @returns {Promise<{ checks: Array<{ id: string, description: string, expected: any, actual: any, pass: boolean }> }>}
 *   The full report; a check failed when `pass` is false.
 * @throws {Error} When a snapshot file is missing, bindings.json belongs to another Vendure, the
 *   login fails, or the job queue does not drain within `config.verify.jobWaitMs`.
 */
export async function verify(config, snapshotDir, deps = {}) {
    const model = await readJson(path.join(snapshotDir, 'model.json'));
    const gaps = await readJson(path.join(snapshotDir, 'gaps.json'));
    const decisions = await readJson(path.join(snapshotDir, 'decisions.json'));
    const extractManifest = await readJson(path.join(snapshotDir, 'manifest.extract.json'));
    const loadResult = await readJson(path.join(snapshotDir, 'load-result.json')).catch(() => undefined);
    const bindings = await openBindings(config, snapshotDir, { readOnly: true });
    const client = deps.client ?? new VendureClient(config.target, config.http);
    await client.login();

    const jobWaitMs = await waitForJobs(client, config.verify.jobWaitMs);
    // Jobs are dated from the load's start when its result is there; older ones are not its doing.
    const jobsSince = loadResult?.startedAt;
    const jobTotals = await jobTotalsByQueue(client, jobsSince);
    const jobsFailed = await failedJobs(client, jobsSince);
    log(`verify: job queue drained after ${jobWaitMs} ms of waiting; totals ${JSON.stringify(jobTotals)}, failed ${jobsFailed.total}`);
    const checks = [];
    const check = (id, description, expected, actual, detail) => {
        const pass = JSON.stringify(expected) === JSON.stringify(actual);
        checks.push({ id, description, expected, actual, pass, detail });
        log(`${pass ? 'PASS' : 'FAIL'} ${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };

    // ----- counts ---------------------------------------------------------------------------
    const c = await client.gql(`{
        products(options: { take: 1 }) { totalItems }
        productVariants(options: { take: 1 }) { totalItems }
        facets(options: { take: 1 }) { totalItems }
        facetValues(options: { take: 1 }) { totalItems }
        collections(options: { take: 1 }) { totalItems }
        assets(options: { take: 1 }) { totalItems }
        countries(options: { take: 1 }) { totalItems }
        zones(options: { take: 1 }) { totalItems }
        taxRates(options: { take: 1 }) { totalItems }
        search(input: { take: 1, groupByProduct: false }) { totalItems }
    }`);
    const e = model.expected;
    check('H1a', 'Vendure products = model products (Shopware top-level products)', e.products, c.products.totalItems);
    check('H1b', 'Vendure variants = model offers (Shopware children + simple products; no parent became buyable)', e.variants, c.productVariants.totalItems);
    check('count.facets', 'facets', e.facets, c.facets.totalItems);
    check('count.facetValues', 'facet values', e.facetValues, c.facetValues.totalItems);
    check('count.collections', 'collections', e.collections, c.collections.totalItems);
    check('count.assets', 'assets', e.assets, c.assets.totalItems);
    check('count.countries', 'countries', e.countries, c.countries.totalItems);
    check('count.zones', 'zones (tax zones + 1 shipping zone)', e.taxZones + 1, c.zones.totalItems);
    check('count.taxRates', 'tax rates', e.taxRates, c.taxRates.totalItems);
    check('count.searchIndex', 'search index entries = model offers (index jobs ran)', e.variants, c.search.totalItems);
    check('jobs.failed', jobsSince ? 'background jobs that FAILED since the load started' : 'background jobs in state FAILED', 0, jobsFailed.total);

    // ----- per-variant comparison ------------------------------------------------------------
    const mismatches = compareVariants(model, bindings, await allVariants(client));
    // Load refuses offers without a tax category, so each one is a variant missing from Vendure.
    check('H2', 'model offers without a tax category after inheritance (load does not create them)', 0, e.variantsWithoutTaxAfterInheritance);
    check('H3', 'variants whose option combination differs from the model', 0, mismatches.options.length);
    check('variant.missing', 'model offers with no bound Vendure variant', 0, mismatches.missing.length);
    check('variant.sku', 'variants whose SKU differs from the model', 0, mismatches.sku.length);
    check('variant.product', 'variants attached to the wrong product', 0, mismatches.product.length);
    check('variant.price', `variants whose ${model.pricesIncludeTax ? 'gross price (priceWithTax)' : 'net price (price)'} differs from the model (minor units)`, 0, mismatches.price.length);
    check('variant.tax', 'variants whose tax category is not the one bound to the model tax category', 0, mismatches.tax.length);
    check('variant.enabled', 'variants with the wrong enabled flag', 0, mismatches.enabled.length);
    check('variant.stock', 'variants with the wrong stock', 0, mismatches.stock.length);

    // ----- collection membership --------------------------------------------------------------
    const membership = await compareMembership(model, bindings, client);
    check('collections.membership', 'collections whose variant count differs from the model listing membership', 0, membership.length);

    // ----- translations ------------------------------------------------------------------------
    const translationMismatches = await compareTranslations(model, bindings, client);
    for (const [code, list] of Object.entries(translationMismatches)) {
        check(`translations.${code}`, `products whose "${code}" name differs from the model's "${code}" name`, 0, list.length);
    }

    // ----- identity and report ---------------------------------------------------------------
    const identity = {
        source: extractManifest.source,
        snapshot: path.basename(snapshotDir),
        extractFileHashes: Object.fromEntries(Object.entries(extractManifest.files).map(([k, v]) => [k, v.sha256.slice(0, 12)])),
        migratorCommit: migratorCommit(),
        target: { adminApi: config.target.adminApi, label: config.target.label },
        verifiedAt: new Date().toISOString(),
    };
    const report = { identity, jobWaitMs, jobsSince: jobsSince ?? null, jobTotals, jobsFailed, checks, mismatches, membership, translationMismatches, load: loadResult };
    await writeJson(path.join(snapshotDir, 'verify-report.json'), report);
    await fs.writeFile(path.join(snapshotDir, 'report.md'), renderMarkdown(report, model, gaps, decisions), 'utf8');
    const failed = checks.filter(x => !x.pass).length;
    log(`verify done: ${checks.length - failed}/${checks.length} checks passed`);
    return report;
}

function renderMarkdown(report, model, gaps, decisions) {
    const { identity, checks, load } = report;
    const lines = [];
    lines.push('# Shopware 6 to Vendure: catalogue migration report', '');
    lines.push(`Source: ${identity.source.label} (MySQL ${identity.source.identity?.mysql_version}, ${identity.source.identity?.migrations} migrations). Snapshot \`${identity.snapshot}\`. Migrator commit \`${identity.migratorCommit}\`. Target: ${identity.target.label} at ${identity.target.adminApi}. Verified ${identity.verifiedAt}.`, '');
    lines.push('## Checks', '', '| Id | Check | Expected | Actual | Result |', '|---|---|---:|---:|---|');
    for (const x of checks) lines.push(`| ${x.id} | ${x.description} | ${x.expected} | ${x.actual} | ${x.pass ? 'pass' : '**FAIL**'} |`);
    lines.push('');
    const jobs = Object.entries(report.jobTotals).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push('## Background jobs', '');
    lines.push(report.jobsSince
        ? `Jobs created since the load started at ${report.jobsSince}, per queue: ${jobs}.`
        : `No load result in this snapshot, so jobs cannot be dated. All jobs in Vendure's job list, per queue: ${jobs}.`);
    lines.push(`${report.jobsFailed.total} of them FAILED. The verify waited ${Math.round(report.jobWaitMs / 1000)} s for the queue to drain after it started.`, '');
    for (const j of report.jobsFailed.examples) lines.push(`- job ${j.id} (${j.queueName}, ${j.createdAt}): ${JSON.stringify(j.error)?.slice(0, 200)}`);
    if (report.jobsFailed.examples.length) lines.push('');
    if (load) {
        lines.push('## Load', '');
        lines.push(`${load.failures.length} failures. Timings (ms): ${Object.entries(load.timings).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
        if (load.aborted) lines.push(`The load stopped at ${load.aborted}.`, '');
        for (const f of load.failures.slice(0, 20)) lines.push(`- ${f.step} ${f.sourceId}: ${f.message}`);
        lines.push('');
    }
    lines.push('## Gaps, reported rather than migrated', '');
    lines.push(`- **Rule prices:** ${gaps.rulePrices.rows} tier rows across ${gaps.rulePrices.rules.length} rules. ${gaps.rulePrices.verdict}.`);
    lines.push(`- **Currencies:** ${gaps.currencies.notMigrated.join(', ')}. ${gaps.currencies.verdict}.`);
    lines.push(`- **Visibility:** ${gaps.visibility.offersNotFullyVisibleInStorefront} variants not fully visible in the storefront. ${gaps.visibility.verdict}.`);
    lines.push(`- **Categories:** ${gaps.categories.productStreamCategories} product-stream categories, ${gaps.categories.linkCategoriesSkipped} link categories skipped, ${gaps.categories.hiddenInNavigation} hidden from navigation. ${gaps.categories.verdict}.`);
    lines.push(`- **Closeout:** ${gaps.closeout.offers} variants. ${gaps.closeout.verdict}.`);
    lines.push(`- **Configurator:** ${gaps.configurator.settingsWithPriceOverride} price overrides, ${gaps.configurator.settingsForOptionsNoVariantUses} settings for options no variant uses.`);
    lines.push(`- **SEO:** ${gaps.seo.productsWithSeoUrl} of ${gaps.seo.productsTotal} products and ${gaps.seo.categoriesWithSeoUrl} categories had a Shopware SEO URL; see redirects.csv. ${gaps.seo.verdict}.`);
    lines.push(`- **Not in this slice:** ${gaps.notInSlice.join(', ')}.`, '');
    lines.push('## Decisions', '');
    for (const d of decisions) lines.push(`- **${d.topic}:** ${d.text}`);
    lines.push('');
    return lines.join('\n');
}
