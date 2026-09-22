// oracle against stubbed Shopware, Vendure and MySQL: a variant missing in Vendure is counted,
// the SQL takes its constants as parameters, and rule winners are tallied by id.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SHOPWARE } from '../src/config.mjs';
import { Bindings } from '../src/lib/bindings.mjs';
import { oracle } from '../src/oracle.mjs';

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const price = gross => [{ currencyId: SHOPWARE.CURRENCY, gross }];

test('oracle counts variants missing in Vendure and tallies rule winners by id', async t => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-test-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    const snapshotDir = path.join(outDir, 'snapshots', '2026-09-22T10-00-00-000Z');
    await fs.mkdir(snapshotDir, { recursive: true });
    const offer = (sourceId, sku) => ({ sourceId, sku, priceGrossMinor: 1190, taxSourceId: 't19', enabled: true });
    await fs.writeFile(path.join(snapshotDir, 'model.json'), JSON.stringify({
        families: [
            { sourceId: 'p1', kind: 'simple', offers: [offer('p1', 'ONE')] },
            { sourceId: 'p2', kind: 'simple', offers: [offer('p2', 'TWO')] },
        ],
    }));
    await fs.writeFile(path.join(outDir, 'bindings.json'), JSON.stringify({
        target: 'http://v/admin-api',
        bindings: { [Bindings.key('product', 'p1', 'variant')]: 'V1' },
    }));

    const fetch = async (url, init) => {
        if (url.endsWith('/api/oauth/token')) return json({ access_token: 'tok' });
        if (url.endsWith('/api/search/product')) {
            return json({ data: [{ id: 'p1', price: price(11.9), taxId: 't19', active: true }, { id: 'p2', price: price(11.9), taxId: 't19', active: true }] });
        }
        if (url.endsWith('/store-api/product')) {
            assert.equal(init.headers['sw-access-key'], 'key');
            const tiers = [{ unitPrice: 9.9 }];
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
            return { productVariants: { totalItems: 1, items: [{ id: 'V1', sku: 'ONE', name: 'One', priceWithTax: 1190, enabled: true, product: { name: 'One' } }] } };
        },
    };
    const queries = [];
    const connect = async () => ({
        async execute(sql, params = []) {
            queries.push({ sql, params });
            if (/FROM rule/.test(sql)) return [[{ id: 'r1', name: 'Same name', priority: 1 }, { id: 'r2', name: 'Same name', priority: 2 }]];
            return [[{ product_id: 'p1', rule_id: 'r1', gross: '9.9' }, { product_id: 'p1', rule_id: 'r2', gross: '8.9' }]];
        },
        async end() {},
    });
    const config = {
        outDir,
        target: { adminApi: 'http://v/admin-api' },
        source: { mediaBaseUrl: 'http://shop/', adminUser: 'a', adminPassword: 'b', storeAccessKey: 'key' },
        http: { timeoutMs: 1000, retries: 0, retryDelayMs: 1 },
    };

    const result = await oracle(config, snapshotDir, { client, fetch, connect });
    assert.deepEqual(result.resolver.missingInVendure, ['TWO']);
    assert.equal(result.resolverMismatches, 1);
    assert.deepEqual(result.ruleSelection.winnerTally, { r1: { name: 'Same name', count: 1 } });

    const [tiers] = queries;
    assert.deepEqual(tiers.params, [`$.c${SHOPWARE.CURRENCY}.gross`, SHOPWARE.LIVE_VERSION]);
    assert.ok(!tiers.sql.includes(SHOPWARE.LIVE_VERSION) && !tiers.sql.includes(SHOPWARE.CURRENCY), 'constants are parameters, not SQL text');
});
