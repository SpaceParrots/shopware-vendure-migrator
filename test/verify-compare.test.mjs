// verify's comparisons against a stubbed Vendure: SKU, price by channel mode, tax category by
// id, collections without a binding, per-language names, the job queue wait, and one full run.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Bindings } from '../src/lib/bindings.mjs';
import { ACTIVE_JOB_STATES, compareMembership, compareTranslations, compareVariants, failedJobs, verify, waitForJobs } from '../src/verify.mjs';

/** Read-only stand-in for Bindings, filled from [entity, sourceId, role, id] rows. */
function bindingsOf(rows) {
    const map = new Map(rows.map(([e, s, r, id]) => [Bindings.key(e, s, r), id]));
    return { get: (e, s, r) => map.get(Bindings.key(e, s, r)) };
}

const model = (over = {}) => ({
    defaultLanguageCode: 'en',
    languageCodes: ['en', 'de'],
    pricesIncludeTax: true,
    taxCategories: [{ sourceId: 't19', name: 'Standard' }],
    families: [{
        sourceId: 'fam', sku: 'SHIRT', names: { en: 'Shirt', de: 'Hemd' },
        offers: [{ sourceId: 'v1', sku: 'SHIRT-1', priceGrossMinor: 1190, priceNetMinor: 1000, taxSourceId: 't19', optionSourceIds: ['o1'], enabled: true, stockOnHand: 3 }],
    }],
    collections: [
        { sourceId: 'cat-a', names: { en: 'A' }, offerSourceIds: ['v1'] },
        { sourceId: 'cat-b', names: { en: 'B' }, offerSourceIds: ['v1'] },
        { sourceId: 'cat-empty', names: { en: 'Empty' }, offerSourceIds: [] },
    ],
    ...over,
});
const bound = bindingsOf([
    ['product', 'fam', 'product', 'P1'],
    ['product', 'v1', 'variant', 'V1'],
    ['tax', 't19', 'taxCategory', 'T1'],
    ['productOption', 'fam|o1', 'option', 'O1'],
    ['category', 'cat-a', 'collection', 'C1'],
]);
const variant = (over = {}) => ({
    id: 'V1', sku: 'SHIRT-1', enabled: true, price: 1000, priceWithTax: 1190, stockOnHand: 3,
    taxCategory: { id: 'T1', name: 'Standard' }, product: { id: 'P1' }, options: [{ id: 'O1' }], ...over,
});
const count = m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.length]));
const clean = { missing: 0, sku: 0, price: 0, tax: 0, options: 0, enabled: 0, stock: 0, product: 0 };

test('a matching variant passes every comparison', () => {
    assert.deepEqual(count(compareVariants(model(), bound, [variant()])), clean);
});

test('a SKU mismatch is reported', () => {
    const m = compareVariants(model(), bound, [variant({ sku: 'OTHER' })]);
    assert.deepEqual(m.sku, [{ expected: 'SHIRT-1', actual: 'OTHER' }]);
});

test('the price is compared in the channel mode: priceWithTax to gross, price to net', () => {
    assert.equal(compareVariants(model(), bound, [variant({ price: 999 })]).price.length, 0, 'gross mode ignores the derived net');
    assert.equal(compareVariants(model(), bound, [variant({ priceWithTax: 1191 })]).price.length, 1);
    const net = model({ pricesIncludeTax: false });
    assert.equal(compareVariants(net, bound, [variant({ priceWithTax: 1191 })]).price.length, 0, 'net mode ignores the derived gross');
    assert.deepEqual(compareVariants(net, bound, [variant({ price: 1190 })]).price.map(p => [p.expected, p.actual]), [[1000, 1190]]);
});

test('the tax category is compared by bound id, not by name', () => {
    const m = compareVariants(model(), bound, [variant({ taxCategory: { id: 'T2', name: 'Standard' } })]);
    assert.deepEqual(m.tax.map(t => [t.expected, t.actual]), [['T1', 'T2']]);
});

test('a variant that is not bound or not in Vendure is missing', () => {
    assert.deepEqual(compareVariants(model(), bound, []).missing, ['SHIRT-1']);
    assert.deepEqual(compareVariants(model(), bindingsOf([]), [variant()]).missing, ['SHIRT-1']);
});

/** Stub client that answers collection and product queries and records every call. */
function stubClient(answers) {
    const calls = [];
    return {
        calls,
        async gql(query, variables, options) {
            calls.push({ query, variables, options });
            return answers(query, variables, options);
        },
    };
}

test('a collection without a binding is a membership mismatch and is not queried', async () => {
    const client = stubClient(() => ({ collection: { productVariants: { totalItems: 1 } } }));
    const membership = await compareMembership(model(), bound, client);
    assert.deepEqual(membership, [{ category: 'cat-b', name: 'B', expected: 1, actual: null, reason: 'collection not bound' }]);
    assert.deepEqual(client.calls.map(c => c.variables.id), ['C1']);
});

test('names are compared in every model language through the languageCode option', async () => {
    const client = stubClient((q, v, { languageCode }) => ({ product: { name: languageCode === 'de' ? 'Hemd alt' : 'Shirt' } }));
    const result = await compareTranslations(model(), bound, client);
    assert.deepEqual(result, { en: [], de: [{ sku: 'SHIRT', expected: 'Hemd', actual: 'Hemd alt' }] });
    assert.deepEqual(client.calls.map(c => c.options.languageCode), ['en', 'de']);
});

test('the job wait counts RETRYING jobs as not drained', async () => {
    let polls = 0;
    const client = stubClient((q, v) => {
        assert.deepEqual(v.states, ACTIVE_JOB_STATES);
        assert.ok(ACTIVE_JOB_STATES.includes('RETRYING'));
        return { jobs: { totalItems: polls++ < 2 ? 1 : 0 } };
    });
    await waitForJobs(client, 10_000, 1);
    assert.equal(polls, 3);
    await assert.rejects(waitForJobs(stubClient(() => ({ jobs: { totalItems: 4 } })), 5, 1), /4 jobs still pending, running or retrying/);
});

test('failed jobs are counted since the load started', async () => {
    const client = stubClient(() => ({ jobs: { totalItems: 2, items: [{ id: '9', queueName: 'update-search-index', error: 'x' }] } }));
    const result = await failedJobs(client, '2026-09-22T10:00:00.000Z');
    assert.equal(result.total, 2);
    assert.deepEqual(client.calls[0].variables.filter, { state: { eq: 'FAILED' }, createdAt: { after: '2026-09-22T10:00:00.000Z' } });
});

test('verify runs end to end on a stubbed Vendure, read-only on the bindings', async t => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-test-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    const snapshotDir = path.join(outDir, 'snapshots', '2026-09-22T10-00-00-000Z');
    await fs.mkdir(snapshotDir, { recursive: true });
    const m = model({ expected: { products: 1, variants: 1, facets: 0, facetValues: 0, collections: 3, assets: 0, countries: 0, taxZones: 0, taxRates: 0, variantsWithoutTaxAfterInheritance: 0 } });
    const gaps = {
        rulePrices: { rows: 0, rules: [], verdict: 'v' }, currencies: { notMigrated: [], verdict: 'v' }, visibility: { offersNotFullyVisibleInStorefront: 0, verdict: 'v' },
        categories: { productStreamCategories: 0, linkCategoriesSkipped: 0, hiddenInNavigation: 0, verdict: 'v' }, closeout: { offers: 0, verdict: 'v' },
        configurator: { settingsWithPriceOverride: 0, settingsForOptionsNoVariantUses: 0 }, seo: { productsWithSeoUrl: 0, productsTotal: 1, categoriesWithSeoUrl: 0, verdict: 'v' }, notInSlice: [],
    };
    const write = (name, data) => fs.writeFile(path.join(snapshotDir, name), JSON.stringify(data));
    await write('model.json', m);
    await write('gaps.json', gaps);
    await write('decisions.json', []);
    await write('manifest.extract.json', { source: { label: 'test' }, files: {} });
    await write('load-result.json', { startedAt: '2026-09-22T10:00:00.000Z', failures: [], timings: {} });
    const rows = [['product', 'fam', 'product', 'P1'], ['product', 'v1', 'variant', 'V1'], ['tax', 't19', 'taxCategory', 'T1'], ['productOption', 'fam|o1', 'option', 'O1'], ['category', 'cat-a', 'collection', 'C1'], ['category', 'cat-b', 'collection', 'C2']];
    const bindingsFile = path.join(outDir, 'bindings.json');
    await fs.writeFile(bindingsFile, JSON.stringify({ target: 'http://v/admin-api', bindings: Object.fromEntries(rows.map(([e, s, r, id]) => [Bindings.key(e, s, r), id])) }));
    const before = await fs.readFile(bindingsFile, 'utf8');

    const total = n => ({ totalItems: n });
    const client = {
        async login() {},
        async gql(query, variables, options) {
            const op = query.slice(query.indexOf('{') + 1).match(/\w+/)[0];
            if (op === 'jobs') return { jobs: { totalItems: 0, items: [] } };
            if (op === 'products') return { products: total(1), productVariants: total(1), facets: total(0), facetValues: total(0), collections: total(3), assets: total(0), countries: total(0), zones: total(1), taxRates: total(0), search: total(1) };
            if (op === 'productVariants') return { productVariants: { totalItems: 1, items: [variant({ sku: 'WRONG' })] } };
            if (op === 'collection') return { collection: { productVariants: total(1) } };
            if (op === 'product') return { product: { name: m.families[0].names[options.languageCode] } };
            throw new Error(`stub has no ${op}`);
        },
    };
    const config = { outDir, target: { adminApi: 'http://v/admin-api', label: 'stub' }, http: {}, verify: { jobWaitMs: 0 } };
    const report = await verify(config, snapshotDir, { client });
    assert.deepEqual(report.checks.filter(c => !c.pass).map(c => c.id), ['variant.sku']);
    assert.equal(report.identity.target.label, 'stub');
    assert.match(await fs.readFile(path.join(snapshotDir, 'report.md'), 'utf8'), /Jobs created since the load started at 2026-09-22T10:00:00.000Z/);
    assert.equal(await fs.readFile(bindingsFile, 'utf8'), before, 'verify does not write bindings.json');
    await assert.rejects(fs.stat(path.join(snapshotDir, 'verify-journal.ndjson')), { code: 'ENOENT' });
});
