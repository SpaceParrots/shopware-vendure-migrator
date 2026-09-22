// oracle against stubbed Shopware, Vendure and MySQL: a variant missing in Vendure is counted,
// the SQL takes its constants as parameters, rule winners are tallied by id, prices are compared
// in the channel mode (gross or net), and offers transform refused are no resolver mismatch.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SHOPWARE } from '../src/config.mjs';
import { Bindings } from '../src/lib/bindings.mjs';
import { compareOffers, oracle } from '../src/oracle.mjs';

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const price = (gross, net) => [{ currencyId: SHOPWARE.CURRENCY, gross, net, linked: true }];

/**
 * One oracle run with two offers, p1 bound to V1 and p2 not bound. Shopware's base price is 11.90
 * gross, 10.00 net; the guest pays rule r1's tier-1 price, 9.90 gross or 8.32 net.
 */
async function runOracle(t, { pricesIncludeTax, refused = [] }) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-test-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    const snapshotDir = path.join(outDir, 'snapshots', '2026-09-22T10-00-00-000Z');
    await fs.mkdir(snapshotDir, { recursive: true });
    const offer = (sourceId, sku) => ({ sourceId, sku, priceGrossMinor: 1190, priceNetMinor: 1000, taxSourceId: 't19', enabled: true });
    await fs.writeFile(path.join(snapshotDir, 'model.json'), JSON.stringify({
        pricesIncludeTax,
        families: [
            { sourceId: 'p1', kind: 'simple', offers: [offer('p1', 'ONE')] },
            { sourceId: 'p2', kind: 'simple', offers: [offer('p2', 'TWO')] },
        ],
    }));
    await fs.writeFile(path.join(snapshotDir, 'gaps.json'), JSON.stringify({
        problems: { refusedOffers: refused.map(sourceId => ({ sku: sourceId.toUpperCase(), sourceId, reasons: ['no tax after inheritance'] })) },
    }));
    await fs.writeFile(path.join(outDir, 'bindings.json'), JSON.stringify({
        target: 'http://v/admin-api',
        bindings: { [Bindings.key('product', 'p1', 'variant')]: 'V1' },
    }));

    const fetch = async (url, init) => {
        if (url.endsWith('/api/oauth/token')) return json({ access_token: 'tok' });
        if (url.endsWith('/api/search/product')) {
            return json({ data: [{ id: 'p1', price: price(11.9, 10), taxId: 't19', active: true }, { id: 'p2', price: price(11.9, 10), taxId: 't19', active: true }] });
        }
        if (url.endsWith('/store-api/product')) {
            assert.equal(init.headers['sw-access-key'], 'key');
            const tiers = [{ unitPrice: pricesIncludeTax ? 9.9 : 8.32 }];
            return json({ elements: [
                { id: 'p1', translated: { name: 'One' }, calculatedPrices: tiers },
                { id: 'p2', translated: { name: 'Two' }, calculatedPrices: tiers },
            ] });
        }
        throw new Error(`unexpected ${url}`);
    };
    const client = {
        async login() {},
        async gql() {
            return { productVariants: { totalItems: 1, items: [{ id: 'V1', sku: 'ONE', name: 'One', price: 1000, priceWithTax: 1190, enabled: true, product: { name: 'One' } }] } };
        },
    };
    const queries = [];
    // Tier-1 prices per rule, by the JSON path the query asks for.
    const tierPrices = { gross: { r1: '9.9', r2: '8.9' }, net: { r1: '8.32', r2: '7.48' } };
    const connect = async () => ({
        async execute(sql, params = []) {
            queries.push({ sql, params });
            if (/FROM rule/.test(sql)) return [[{ id: 'r1', name: 'Same name', priority: 1 }, { id: 'r2', name: 'Same name', priority: 2 }]];
            const byRule = tierPrices[params[0].split('.').pop()];
            return [[{ product_id: 'p1', rule_id: 'r1', price: byRule.r1 }, { product_id: 'p1', rule_id: 'r2', price: byRule.r2 }]];
        },
        async end() {},
    });
    const config = {
        outDir,
        target: { adminApi: 'http://v/admin-api' },
        source: { mediaBaseUrl: 'http://shop/', adminUser: 'a', adminPassword: 'b', storeAccessKey: 'key' },
        http: { timeoutMs: 1000, retries: 0, retryDelayMs: 1 },
    };
    return { result: await oracle(config, snapshotDir, { client, fetch, connect }), queries };
}

test('oracle counts variants missing in Vendure and tallies rule winners by id', async t => {
    const { result, queries } = await runOracle(t, { pricesIncludeTax: true });
    assert.deepEqual(result.resolver.missingInVendure, ['TWO']);
    assert.equal(result.resolverMismatches, 1);
    assert.deepEqual(result.ruleSelection.winnerTally, { r1: { name: 'Same name', count: 1 } });

    const [tiers] = queries;
    assert.deepEqual(tiers.params, [`$.c${SHOPWARE.CURRENCY}.gross`, SHOPWARE.LIVE_VERSION]);
    assert.ok(!tiers.sql.includes(SHOPWARE.LIVE_VERSION) && !tiers.sql.includes(SHOPWARE.CURRENCY), 'constants are parameters, not SQL text');
});

test('an offer transform refused is counted apart, and its absence from Vendure is no resolver mismatch', async t => {
    const { result } = await runOracle(t, { pricesIncludeTax: true, refused: ['p2'] });
    assert.equal(result.refusedOffers, 1);
    assert.deepEqual(result.resolver.missingInVendure, []);
    assert.equal(result.resolverMismatches, 0);
    assert.deepEqual(result.names.mismatch, []);
    assert.equal(result.compared, 1);
});

test('a refused offer that is in Vendure anyway is still compared', () => {
    const offer = { sourceId: 'p1', sku: 'ONE', priceGrossMinor: 1190, priceNetMinor: 1000, taxSourceId: 't19', enabled: true };
    const model = { currencyDecimals: 2, pricesIncludeTax: true, families: [{ sourceId: 'p1', kind: 'simple', offers: [offer] }] };
    const admin = [{ id: 'p1', price: price(11.9, 10), taxId: 't7', active: true }];
    const vendure = [{ id: 'V1', price: 1000, priceWithTax: 1190 }];
    const { r } = compareOffers({ model, bindings: { get: () => 'V1' }, admin, store: [], vendure, refusedSourceIds: new Set(['p1']) });
    assert.equal(r.refusedOffers, 1);
    assert.equal(r.compared, 1);
    assert.deepEqual(r.resolver.taxMismatch, [{ sku: 'ONE', shopware: 't7', model: 't19' }]);
});

test('in a net channel oracle compares net base, guest and rule prices', async t => {
    const { result, queries } = await runOracle(t, { pricesIncludeTax: false });
    assert.equal(result.priceField, 'net');
    assert.deepEqual(result.resolver.basePriceMismatch, []);
    assert.equal(result.resolverMismatches, 1);
    // Guest 8.32 net against Vendure's net price 1000, not its priceWithTax 1190.
    assert.deepEqual(result.guestPrice.examples, [{ sku: 'ONE', shopwareGuest: 832, vendure: 1000 }]);
    assert.equal(result.guestPrice.maxAbsDiffMinor, 168);
    assert.deepEqual(queries[0].params, [`$.c${SHOPWARE.CURRENCY}.net`, SHOPWARE.LIVE_VERSION]);
    assert.deepEqual(result.ruleSelection.winnerTally, { r1: { name: 'Same name', count: 1 } });
});

test('compareOffers converts the Admin API gross by the transform rule: a linked sub-cent gross is rounded, not a mismatch', () => {
    const offer = (sourceId, sku, priceGrossMinor) => ({ sourceId, sku, priceGrossMinor, taxSourceId: 't19', enabled: true });
    const model = {
        currencyDecimals: 2,
        pricesIncludeTax: true,
        families: [{ sourceId: 'p1', kind: 'simple', offers: [offer('p1', 'LINKED', 1232)] }, { sourceId: 'p2', kind: 'simple', offers: [offer('p2', 'UNLINKED', 1232)] }],
    };
    const bindings = { get: (kind, id) => ({ p1: 'V1', p2: 'V2' })[id] };
    const entry = linked => [{ currencyId: SHOPWARE.CURRENCY, gross: 12.3165, net: 10.35, linked }];
    const admin = [{ id: 'p1', price: entry(true), taxId: 't19', active: true }, { id: 'p2', price: entry(false), taxId: 't19', active: true }];
    const vendure = [{ id: 'V1', priceWithTax: 1232 }, { id: 'V2', priceWithTax: 1232 }];
    const { r } = compareOffers({ model, bindings, admin, store: [], vendure });
    // UNLINKED is a real mismatch: transform refuses its sub-cent gross, so the model could not hold 1232.
    assert.deepEqual(r.resolver.basePriceMismatch.map(m => m.sku), ['UNLINKED']);
});

test('compareOffers checks the channel-mode base price: gross in a gross channel, net in a net channel', () => {
    const offer = (sourceId, sku, priceGrossMinor, priceNetMinor) => ({ sourceId, sku, priceGrossMinor, priceNetMinor, taxSourceId: 't19', enabled: true });
    const families = [
        // Linked, so transform derived the sub-cent net 10.3465 and rounded it half-up to 1035.
        { sourceId: 'p1', kind: 'simple', offers: [offer('p1', 'NET_LINKED', 1231, 1035)] },
        // Not linked: transform refuses the sub-cent net, so a net model price of 1035 is wrong.
        { sourceId: 'p2', kind: 'simple', offers: [offer('p2', 'NET_UNLINKED', 1231, 1035)] },
        // Vendure's gross differs, its net matches.
        { sourceId: 'p3', kind: 'simple', offers: [offer('p3', 'GROSS_OFF', 1190, 1000)] },
        // Vendure's net differs, its gross matches.
        { sourceId: 'p4', kind: 'simple', offers: [offer('p4', 'NET_OFF', 1190, 1000)] },
    ];
    const bindings = { get: (kind, id) => `V${id.slice(1)}` };
    const subCentNet = linked => [{ currencyId: SHOPWARE.CURRENCY, gross: 12.31, net: 10.3465, linked }];
    const plain = [{ currencyId: SHOPWARE.CURRENCY, gross: 11.9, net: 10, linked: true }];
    const admin = [
        { id: 'p1', price: subCentNet(true) }, { id: 'p2', price: subCentNet(false) }, { id: 'p3', price: plain }, { id: 'p4', price: plain },
    ].map(a => ({ ...a, taxId: 't19', active: true }));
    const vendure = [
        { id: 'V1', price: 1035, priceWithTax: 1231 },
        { id: 'V2', price: 1035, priceWithTax: 1231 },
        { id: 'V3', price: 1000, priceWithTax: 1200 },
        { id: 'V4', price: 1001, priceWithTax: 1190 },
    ];
    const mismatches = pricesIncludeTax => {
        const { r } = compareOffers({ model: { currencyDecimals: 2, pricesIncludeTax, families }, bindings, admin, store: [], vendure });
        return { field: r.priceField, list: r.resolver.basePriceMismatch };
    };

    assert.deepEqual(mismatches(false), {
        field: 'net',
        list: [
            { sku: 'NET_UNLINKED', shopware: null, model: 1035, vendure: 1035 },
            { sku: 'NET_OFF', shopware: 1000, model: 1000, vendure: 1001 },
        ],
    });
    // The gross of p1 and p2 is exact, so only the variant with a different gross remains.
    assert.deepEqual(mismatches(true), { field: 'gross', list: [{ sku: 'GROSS_OFF', shopware: 1190, model: 1190, vendure: 1200 }] });
});
