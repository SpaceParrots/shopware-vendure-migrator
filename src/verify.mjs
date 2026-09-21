// Stage 6: prove the result, not just the presence of records. Every variant is compared
// field by field with the intermediate model; collections are compared by membership.
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bindings } from './lib/bindings.mjs';
import { log, readJson, writeJson } from './lib/util.mjs';
import { VendureClient } from './lib/vendure-client.mjs';

const JOB_WAIT_MS = 10 * 60 * 1000;

async function waitForJobs(client) {
    const t0 = Date.now();
    while (Date.now() - t0 < JOB_WAIT_MS) {
        const { jobs } = await client.gql(
            `{ jobs(options: { filter: { state: { in: ["PENDING", "RUNNING"] } }, take: 1 }) { totalItems } }`,
        );
        if (jobs.totalItems === 0) return Date.now() - t0;
        log(`verify: waiting for ${jobs.totalItems} jobs`);
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Job queue did not drain in time; is the Vendure worker running?');
}

async function allVariants(client) {
    const out = [];
    for (let skip = 0; ; skip += 100) {
        const { productVariants } = await client.gql(
            `query($skip: Int!) { productVariants(options: { take: 100, skip: $skip }) { totalItems items {
                id sku enabled price priceWithTax currencyCode stockOnHand
                taxCategory { name } product { id } options { id } } } }`,
            { skip },
        );
        out.push(...productVariants.items);
        if (out.length >= productVariants.totalItems) return out;
    }
}

export async function verify(config, snapshotDir) {
    const model = await readJson(path.join(snapshotDir, 'model.json'));
    const gaps = await readJson(path.join(snapshotDir, 'gaps.json'));
    const decisions = await readJson(path.join(snapshotDir, 'decisions.json'));
    const extractManifest = await readJson(path.join(snapshotDir, 'manifest.extract.json'));
    const loadResult = await readJson(path.join(snapshotDir, 'load-result.json')).catch(() => undefined);
    const bindings = await new Bindings(path.join(config.outDir, 'bindings.json'), path.join(snapshotDir, 'verify-journal.ndjson')).load();
    const client = new VendureClient(config.target);
    await client.login();

    const jobWaitMs = await waitForJobs(client);
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
    check('H1a', 'Vendure products = Shopware top-level products', e.products, c.products.totalItems);
    check('H1b', 'Vendure variants = Shopware children + simple products (no parent became buyable)', e.variants, c.productVariants.totalItems);
    check('count.facets', 'facets', e.facets, c.facets.totalItems);
    check('count.facetValues', 'facet values', e.facetValues, c.facetValues.totalItems);
    check('count.collections', 'collections', e.collections, c.collections.totalItems);
    check('count.assets', 'assets', e.assets, c.assets.totalItems);
    check('count.countries', 'countries', e.countries, c.countries.totalItems);
    check('count.zones', 'zones (tax zones + 1 shipping zone)', e.taxZones + 1, c.zones.totalItems);
    check('count.taxRates', 'tax rates', e.taxRates, c.taxRates.totalItems);
    check('count.searchIndex', 'search index entries = variants (index jobs ran)', e.variants, c.search.totalItems);

    // ----- per-variant comparison ------------------------------------------------------------
    const variants = await allVariants(client);
    const byId = new Map(variants.map(v => [String(v.id), v]));
    const taxName = new Map(model.taxCategories.map(t => [t.sourceId, t.name]));
    const mismatches = { missing: [], sku: [], price: [], tax: [], options: [], enabled: [], stock: [], product: [] };
    let withoutTax = 0;
    for (const family of model.families) {
        const productId = bindings.get('product', family.sourceId, 'product');
        for (const o of family.offers) {
            const v = byId.get(bindings.get('product', o.sourceId, 'variant'));
            if (!v) { mismatches.missing.push(o.sku); continue; }
            if (!v.taxCategory) withoutTax++;
            if (v.sku !== o.sku) mismatches.sku.push({ expected: o.sku, actual: v.sku });
            if (String(v.product.id) !== String(productId)) mismatches.product.push(o.sku);
            const shown = model.pricesIncludeTax ? v.priceWithTax : v.price;
            if (shown !== o.priceGrossMinor) mismatches.price.push({ sku: o.sku, expected: o.priceGrossMinor, actual: shown });
            if (v.taxCategory?.name !== taxName.get(o.taxSourceId)) mismatches.tax.push({ sku: o.sku, expected: taxName.get(o.taxSourceId), actual: v.taxCategory?.name });
            const expectedOptions = o.optionSourceIds.map(id => bindings.get('productOption', `${family.sourceId}|${id}`, 'option')).sort();
            const actualOptions = v.options.map(x => String(x.id)).sort();
            if (JSON.stringify(expectedOptions) !== JSON.stringify(actualOptions)) mismatches.options.push({ sku: o.sku, expectedOptions, actualOptions });
            if (v.enabled !== o.enabled) mismatches.enabled.push(o.sku);
            if (v.stockOnHand !== o.stockOnHand) mismatches.stock.push({ sku: o.sku, expected: o.stockOnHand, actual: v.stockOnHand });
        }
    }
    check('H2', 'variants without a tax category after inheritance', 0, withoutTax);
    check('H3', 'variants whose option combination differs from the source', 0, mismatches.options.length);
    check('variant.missing', 'model offers with no bound Vendure variant', 0, mismatches.missing.length);
    check('variant.product', 'variants attached to the wrong product', 0, mismatches.product.length);
    check('variant.price', `variants whose ${model.pricesIncludeTax ? 'gross' : 'net'} price differs (minor units)`, 0, mismatches.price.length);
    check('variant.tax', 'variants with the wrong tax category', 0, mismatches.tax.length);
    check('variant.enabled', 'variants with the wrong enabled flag', 0, mismatches.enabled.length);
    check('variant.stock', 'variants with the wrong stock', 0, mismatches.stock.length);

    // ----- collection membership --------------------------------------------------------------
    const membership = [];
    for (const col of model.collections.filter(x => x.offerSourceIds.length)) {
        const id = bindings.get('category', col.sourceId, 'collection');
        const { collection } = await client.gql(
            `query($id: ID!) { collection(id: $id) { productVariants(options: { take: 1 }) { totalItems } } }`,
            { id },
        );
        const actual = collection?.productVariants.totalItems ?? null;
        if (actual !== col.offerSourceIds.length) membership.push({ category: col.sourceId, name: col.names.en, expected: col.offerSourceIds.length, actual });
    }
    check('collections.membership', 'collections whose variant count differs from the Shopware assignments', 0, membership.length);

    // ----- translations ------------------------------------------------------------------------
    const translationMismatches = [];
    for (const family of model.families.filter(f => f.names.de)) {
        const id = bindings.get('product', family.sourceId, 'product');
        const res = await fetch(`${config.target.adminApi}?languageCode=de`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${client.token}` },
            body: JSON.stringify({ query: `query($id: ID!) { product(id: $id) { name } }`, variables: { id } }),
        });
        const name = (await res.json()).data?.product?.name;
        if (name !== family.names.de) translationMismatches.push({ sku: family.sku, expected: family.names.de, actual: name });
    }
    check('translations.de', 'products whose German name differs from the authored German name', 0, translationMismatches.length);

    // ----- identity and report ---------------------------------------------------------------
    let migratorCommit = 'unknown';
    try {
        migratorCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
        if (execSync('git status --porcelain -- src', { encoding: 'utf8' }).trim()) migratorCommit += '+dirty';
    } catch { /* not a git checkout */ }
    const identity = {
        source: extractManifest.source,
        snapshot: path.basename(snapshotDir),
        extractFileHashes: Object.fromEntries(Object.entries(extractManifest.files).map(([k, v]) => [k, v.sha256.slice(0, 12)])),
        migratorCommit,
        target: { adminApi: config.target.adminApi, label: process.env.TARGET_LABEL ?? 'unlabelled' },
        verifiedAt: new Date().toISOString(),
    };
    const report = { identity, jobWaitMs, checks, mismatches, membership, translationMismatches, load: loadResult };
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
    if (load) {
        lines.push('## Load', '');
        lines.push(`${load.failures.length} failures. Timings (ms): ${Object.entries(load.timings).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
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
