// load() against a fake Vendure: a missing dependency holds back the dependent object instead
// of creating it without the reference, offers without price or tax are refused, the channel's
// price mode picks gross or net, and partly created option groups and facets are completed on
// the next run without duplicates.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load } from '../src/load.mjs';
import { matchByCode } from '../src/load/context.mjs';

/** In-memory stand-in for the Vendure Admin API, dispatching on the first field of a document. */
class FakeVendure {
    constructor() {
        this.calls = [];
        this.nextId = 1;
        this.failNext = {};
        this.facetValues = new Map();
        this.groupOptions = new Map();
        this.productGroups = new Map();
        // Hooks to imitate Vendure changing or dropping codes.
        this.childCode = code => code;
        this.dropLastFacetValue = false;
    }
    id() { return String(this.nextId++); }
    async login() {}
    async uploadAsset(fileName) {
        this.calls.push({ op: 'uploadAsset', variables: { fileName } });
        return this.id();
    }
    ofOp(op) { return this.calls.filter(c => c.op === op); }
    async gql(query, variables = {}) {
        const op = query.slice(query.indexOf('{') + 1).match(/\w+/)[0];
        const call = { op, variables };
        this.calls.push(call);
        call.result = await this.answer(op, variables);
        return call.result;
    }
    async answer(op, variables) {
        if (this.failNext[op]) {
            this.failNext[op]--;
            throw new Error(`fake ${op} failed`);
        }
        const input = variables.input;
        switch (op) {
            case 'updateGlobalSettings': return { updateGlobalSettings: { availableLanguages: input.availableLanguages } };
            case 'activeChannel': return { activeChannel: { id: '1' } };
            case 'updateChannel': return { updateChannel: { id: '1' } };
            case 'createCountry': case 'createZone': case 'createTaxCategory': case 'createTaxRate':
            case 'createProduct': case 'createCollection':
                return { [op]: { id: this.id() } };
            case 'createFacet': {
                const id = this.id();
                let values = input.values.map(v => ({ id: this.id(), code: this.childCode(v.code) }));
                if (this.dropLastFacetValue) values = values.slice(0, -1);
                this.facetValues.set(id, values);
                return { createFacet: { id, values } };
            }
            case 'facet': return { facet: { values: this.facetValues.get(variables.id) } };
            case 'createFacetValues': {
                const values = input.map(v => ({ id: this.id(), code: v.code }));
                this.facetValues.get(input[0].facetId).push(...values);
                return { createFacetValues: values };
            }
            case 'createProductOptionGroup': {
                const id = this.id();
                const options = input.options.map(o => ({ id: this.id(), code: this.childCode(o.code) }));
                this.groupOptions.set(id, options);
                return { createProductOptionGroup: { id, options } };
            }
            case 'productOptionGroup': return { productOptionGroup: { options: this.groupOptions.get(variables.id) } };
            case 'product': return { product: { optionGroups: (this.productGroups.get(variables.id) ?? []).map(id => ({ id })) } };
            case 'addOptionGroupToProduct': {
                this.productGroups.set(variables.p, [...(this.productGroups.get(variables.p) ?? []), variables.g]);
                return { addOptionGroupToProduct: { id: variables.p } };
            }
            case 'createProductVariants': return { createProductVariants: input.map(v => ({ id: this.id(), sku: v.sku })) };
            default: throw new Error(`fake has no ${op}`);
        }
    }
}

const offer = (sourceId, sku, optionSourceIds, over = {}) => ({
    sourceId, sku, enabled: true, priceGrossMinor: 1190, priceNetMinor: 1000, taxSourceId: 't19',
    manufacturerSourceId: 'm-acme', stockOnHand: 5, optionSourceIds, ownPropertyOptionIds: [],
    mediaSourceIds: [], coverMediaSourceId: null, names: {}, ...over,
});
const asset = (sourceId, isPrivate = false) => ({ sourceId, url: `http://shop/${sourceId}.png`, fileName: `${sourceId}.png`, mimeType: 'image/png', private: isPrivate });
const category = (sourceId, parentSourceId, offerSourceIds) => ({ sourceId, parentSourceId, names: { en: sourceId }, descriptions: {}, slugs: {}, isPrivate: false, offerSourceIds });

function model(over = {}) {
    return {
        defaultLanguageCode: 'en',
        languageCodes: ['en', 'de'],
        currencyCode: 'EUR',
        pricesIncludeTax: true,
        countries: [
            { sourceId: 'c-de', code: 'DE', enabled: true, names: { en: 'Germany' } },
            { sourceId: 'c-at', code: 'AT', enabled: true, names: { en: 'Austria' } },
        ],
        taxCategories: [{ sourceId: 't19', name: 'Standard', isDefault: true }],
        taxZones: [{ key: 'z1', name: 'DE and AT', countryCodes: ['DE', 'AT'], rates: { t19: 19 }, isDefault: true }],
        facets: [
            { sourceId: 'g-color', kind: 'property', code: 'prop-color', names: { en: 'Color' }, values: [
                { sourceId: 'o-red', code: 'red', names: { en: 'Red' } },
                { sourceId: 'o-blue', code: 'blue', names: { en: 'Blue' } },
            ] },
            { sourceId: 'manufacturer', kind: 'manufacturer', code: 'manufacturer', names: { en: 'Manufacturer' }, values: [
                { sourceId: 'm-acme', code: 'acme', names: { en: 'Acme' } },
            ] },
        ],
        assets: [asset('media-1'), asset('media-2'), asset('media-private', true)],
        families: [
            {
                sourceId: 'fam-1', kind: 'family', sku: 'SHIRT', names: { en: 'Shirt' }, descriptions: {}, slugs: {}, enabled: true,
                propertyOptionIds: ['o-red'], manufacturerSourceId: 'm-acme', mediaSourceIds: ['media-1', 'media-private'], coverMediaSourceId: 'media-1',
                optionGroups: [{ sourceId: 'g-color', names: { en: 'Color' }, optionSourceIds: ['o-red', 'o-blue'] }],
                offers: [
                    offer('v-red', 'SHIRT-RED', ['o-red']),
                    offer('v-blue', 'SHIRT-BLUE', ['o-blue'], { mediaSourceIds: ['media-2'], coverMediaSourceId: 'media-2' }),
                ],
            },
            {
                sourceId: 'mug', kind: 'simple', sku: 'MUG', names: { en: 'Mug' }, descriptions: {}, slugs: {}, enabled: true,
                propertyOptionIds: [], manufacturerSourceId: null, mediaSourceIds: [], coverMediaSourceId: null, optionGroups: [],
                offers: [offer('mug', 'MUG', [], { priceGrossMinor: null, priceNetMinor: null, manufacturerSourceId: null })],
            },
        ],
        collections: [category('cat-root', null, ['v-red', 'v-blue', 'mug']), category('cat-child', 'cat-root', ['v-blue'])],
        expected: {},
        ...over,
    };
}

async function setup(t, m) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'load-test-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    const snapshotDir = path.join(outDir, 'snapshots', '2026-09-22T10-00-00-000Z');
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, 'model.json'), JSON.stringify(m));
    const config = { outDir, target: { adminApi: 'http://fake/admin-api' }, http: { timeoutMs: 1000, retries: 0, retryDelayMs: 1 } };
    return { config, snapshotDir };
}

const images = ({ broken = [] } = {}) => async url => (broken.some(b => url.endsWith(b))
    ? new Response('gone', { status: 404 })
    : new Response(new Uint8Array([1, 2, 3])));
const failed = result => result.failures.map(f => `${f.step} ${f.sourceId}`);
const variantInputs = fake => fake.ofOp('createProductVariants').flatMap(c => c.variables.input);

test('a missing asset holds back the variant and collections that use it until a later run', async t => {
    const { config, snapshotDir } = await setup(t, model());
    const fake = new FakeVendure();

    const first = await load(config, snapshotDir, { client: fake, fetch: images({ broken: ['media-2.png'] }) });
    assert.deepEqual(failed(first).sort(), ['assets media-2', 'collections cat-child', 'collections cat-root', 'variants MUG', 'variants SHIRT-BLUE']);
    assert.deepEqual(variantInputs(fake).map(v => v.sku), ['SHIRT-RED']);
    assert.equal(fake.ofOp('createCollection').length, 0, 'no collection without all its members');
    const product = fake.ofOp('createProduct')[0].variables.input;
    assert.equal(fake.ofOp('createProduct').length, 1, 'no empty product for the refused MUG');
    assert.equal(product.assetIds.length, 1, 'the private medium is left out, not awaited');
    assert.equal(product.facetValueIds.length, 2, 'property value and manufacturer value');

    const second = await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.deepEqual(failed(second), ['variants MUG']);
    assert.equal(fake.ofOp('createProduct').length, 1);
    assert.deepEqual(variantInputs(fake).map(v => v.sku), ['SHIRT-RED', 'SHIRT-BLUE']);
    const blue = variantInputs(fake)[1];
    assert.equal(blue.assetIds.length, 1);
    assert.equal(blue.featuredAssetId, blue.assetIds[0]);

    const [root, child] = fake.ofOp('createCollection').map(c => c.variables.input);
    const members = JSON.parse(root.filters[0].arguments[0].value);
    assert.equal(members.length, 2, 'the refused MUG is left out; both shirts are in');
    assert.equal(second.counts.collections.membersExcluded, 1);
    assert.equal(child.parentId, fake.ofOp('createCollection')[0].result.createCollection.id);
});

test('a missing country holds back its zones and the load stops at the channel', async t => {
    const { config, snapshotDir } = await setup(t, model());
    const fake = new FakeVendure();
    fake.failNext.createCountry = 1;

    await assert.rejects(load(config, snapshotDir, { client: fake, fetch: images() }), /load stopped at channel: zone tax:z1 is not in Vendure yet/);
    assert.equal(fake.ofOp('createZone').length, 0, 'no zone without all its countries');
    assert.equal(fake.ofOp('createTaxRate').length, 0);
    assert.equal(fake.ofOp('createProduct').length, 0, 'nothing is created before the channel is set');
    const result = JSON.parse(await fs.readFile(path.join(snapshotDir, 'load-result.json'), 'utf8'));
    assert.match(result.aborted, /^channel:/);
    assert.deepEqual(failed(result).slice(0, 4), ['countries DE', 'zones tax:z1', 'zones shipping:storefront', 'taxRates z1|t19']);

    await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.deepEqual(fake.ofOp('createZone').map(c => c.variables.input.memberIds.length), [2, 2]);
    assert.equal(fake.ofOp('createCountry').length, 3, 'only the failed country is created again');
});

test('the variant price follows the channel: gross with tax included, net without', async t => {
    for (const pricesIncludeTax of [true, false]) {
        const { config, snapshotDir } = await setup(t, model({ pricesIncludeTax }));
        const fake = new FakeVendure();
        await load(config, snapshotDir, { client: fake, fetch: images() });
        const prices = variantInputs(fake).map(v => v.price);
        assert.deepEqual(prices, pricesIncludeTax ? [1190, 1190] : [1000, 1000]);
        assert.equal(fake.ofOp('updateChannel')[0].variables.input.pricesIncludeTax, pricesIncludeTax);
    }
});

test('offers without price or tax are refused and stay unbound', async t => {
    const m = model({ pricesIncludeTax: false });
    m.families[0].offers[0].priceNetMinor = null;
    m.families[0].offers[1].taxSourceId = null;
    const { config, snapshotDir } = await setup(t, m);
    const fake = new FakeVendure();
    const result = await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.equal(variantInputs(fake).length, 0);
    const byStep = Object.fromEntries(result.failures.filter(f => f.step === 'variants').map(f => [f.sourceId, f.message]));
    assert.match(byStep['SHIRT-RED'], /no net price/);
    assert.match(byStep['SHIRT-BLUE'], /no tax category/);
    assert.equal(result.counts.products.variantsFailed, 3);
    // The collections are still created, without the refused offers.
    assert.equal(fake.ofOp('createCollection').length, 2);
});

test('option and facet value codes Vendure changed are still bound', async t => {
    const { config, snapshotDir } = await setup(t, model());
    const fake = new FakeVendure();
    fake.childCode = code => `${code}-2`;
    const result = await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.deepEqual(failed(result), ['variants MUG']);
    const [red, blue] = variantInputs(fake);
    const [group] = fake.groupOptions.values();
    assert.deepEqual([red.optionIds, blue.optionIds], [[group[0].id], [group[1].id]]);
});

test('facet values Vendure did not return are created on their own', async t => {
    const { config, snapshotDir } = await setup(t, model());
    const fake = new FakeVendure();
    fake.dropLastFacetValue = true;
    const result = await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.deepEqual(failed(result), ['variants MUG']);
    assert.deepEqual(fake.ofOp('createFacetValues').map(c => c.variables.input.map(v => v.code)), [['blue'], ['acme']]);
});

test('a failed attach is retried without creating a second option group', async t => {
    const { config, snapshotDir } = await setup(t, model());
    const fake = new FakeVendure();
    fake.failNext.addOptionGroupToProduct = 1;
    const first = await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.ok(failed(first).includes('products SHIRT'));
    assert.equal(variantInputs(fake).length, 0, 'no variants before their options are attached');

    const second = await load(config, snapshotDir, { client: fake, fetch: images() });
    assert.deepEqual(failed(second), ['variants MUG']);
    assert.equal(fake.ofOp('createProductOptionGroup').length, 1);
    assert.equal(fake.ofOp('addOptionGroupToProduct').length, 2);
    assert.equal(variantInputs(fake).length, 2);

    // A third run finds everything bound and sends no create at all.
    const before = fake.calls.length;
    await load(config, snapshotDir, { client: fake, fetch: images() });
    const creates = fake.calls.slice(before).filter(c => /^(create|add)/.test(c.op));
    assert.deepEqual(creates.map(c => c.op), [], 'the refused MUG never reaches Vendure');
});

test('matchByCode pairs exact codes, then suffixed codes, then a single leftover', () => {
    const want = codes => codes.map(code => ({ code }));
    const ids = r => r.pairs.map(([item, id]) => `${item.code}=${id}`);
    assert.deepEqual(ids(matchByCode(want(['a', 'b']), [{ id: 2, code: 'b' }, { id: 1, code: 'a' }])), ['a=1', 'b=2']);
    assert.deepEqual(ids(matchByCode(want(['red', 'blue']), [{ id: 1, code: 'red-2' }, { id: 2, code: 'blue-3' }])), ['red=1', 'blue=2']);
    assert.deepEqual(ids(matchByCode(want(['x']), [{ id: 9, code: 'renamed' }])), ['x=9']);
    const ambiguous = matchByCode(want(['x', 'y']), [{ id: 1, code: 'p' }, { id: 2, code: 'q' }]);
    assert.deepEqual([ambiguous.pairs.length, ambiguous.unmatched.length, ambiguous.unclaimed.length], [0, 2, 2]);
    const twoSuffixed = matchByCode(want(['red']), [{ id: 1, code: 'red-2' }, { id: 2, code: 'red-3' }]);
    assert.equal(twoSuffixed.pairs.length, 0);
});
