// Products carry the numbers a shop lives on: which variant exists, what it is called and what it
// costs. Each rule here mirrors a Shopware inheritance or naming rule on a minimal snapshot.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SHOPWARE } from '../src/config.mjs';
import { buildLanguages } from '../src/transform/languages.mjs';
import { buildFamilies } from '../src/transform/products.mjs';

const SYS = SHOPWARE.LANGUAGE_SYSTEM;
const DE = 'lang-de';
const SF = 'sf';
const CUR = `c${SHOPWARE.CURRENCY}`;

const price = (gross, net = gross) => JSON.stringify({ [CUR]: { gross, net, linked: true, currencyId: SHOPWARE.CURRENCY } });
const product = (id, extra = {}) => ({
    id,
    parent_id: null,
    product_number: id.toUpperCase(),
    active: 1,
    tax_id: 'tax',
    manufacturer_id: null,
    price: price(10),
    stock: 5,
    is_closeout: 0,
    cover_product_media_id: null,
    ...extra,
});
const variant = (id, parent, extra = {}) =>
    product(id, { parent_id: parent, active: null, tax_id: null, price: null, is_closeout: null, ...extra });

function snapshot(overrides = {}) {
    return {
        languages: [
            { id: DE, parent_id: null, locale: 'de-DE' },
            { id: SYS, parent_id: null, locale: 'en-GB' },
        ],
        products: [],
        product_translations: [],
        product_options: [],
        product_properties: [],
        product_categories: [],
        product_category_tree: [],
        product_media: [],
        product_visibilities: [],
        property_group_translations: [
            { group_id: 'colour', language_id: SYS, name: 'Colour' },
            { group_id: 'size', language_id: SYS, name: 'Size' },
        ],
        property_group_option_translations: [
            { option_id: 'red', language_id: SYS, name: 'Red' },
            { option_id: 'red', language_id: DE, name: 'Rot' },
            { option_id: 'm', language_id: SYS, name: 'M' },
        ],
        property_group_options: [
            { id: 'red', group_id: 'colour' },
            { id: 'm', group_id: 'size' },
        ],
        ...overrides,
    };
}

function build(raw, { pricesIncludeTax = true } = {}) {
    const lang = buildLanguages(raw.languages, SYS);
    const pricing = { currencyId: SHOPWARE.CURRENCY, decimals: 2, decimalsSource: 'item_rounding', pricesIncludeTax };
    return buildFamilies(raw, { ...lang, storefront: { id: SF }, pricing, productSlugOf: (id, code, name) => `${id}-${code}` });
}

const tr = (product_id, language_id, name) => ({ product_id, language_id, name, description: null });
const offerOf = (result, sourceId) => result.families.flatMap(f => f.offers).find(o => o.sourceId === sourceId);

describe('variant names', () => {
    const raw = snapshot({
        products: [product('p'), variant('v-inherit', 'p'), variant('v-own', 'p')],
        product_translations: [tr('p', SYS, 'Hoodie'), tr('p', DE, 'Kapuzenpulli'), tr('v-own', SYS, 'Hoodie Special'), tr('v-own', DE, 'Kapuzenpulli Spezial')],
        product_options: [
            { product_id: 'v-inherit', option_id: 'red' },
            { product_id: 'v-inherit', option_id: 'm' },
            { product_id: 'v-own', option_id: 'm' },
        ],
    });
    const result = build(raw);

    test('an inherited name gets the option labels of each language appended', () => {
        assert.deepEqual(offerOf(result, 'v-inherit').names, { en: 'Hoodie Red / M', de: 'Kapuzenpulli Rot / M' });
    });

    test('an own name is kept unchanged', () => {
        assert.deepEqual(offerOf(result, 'v-own').names, { en: 'Hoodie Special', de: 'Kapuzenpulli Spezial' });
    });

    test('the parent row is not a variant', () => {
        assert.deepEqual(result.families[0].offers.map(o => o.sourceId), ['v-inherit', 'v-own']);
        assert.equal(result.families[0].kind, 'family');
    });

    test('a variant with only an English name shows the parent German name in German, with option labels', () => {
        const r = build(snapshot({
            products: [product('p'), variant('v', 'p')],
            product_translations: [tr('p', SYS, 'Hoodie'), tr('p', DE, 'Kapuzenpulli'), tr('v', SYS, 'Hoodie Blue')],
            product_options: [{ product_id: 'v', option_id: 'red' }],
        }));
        assert.deepEqual(offerOf(r, 'v').names, { en: 'Hoodie Blue', de: 'Kapuzenpulli Rot' });
    });

    test('a product without variants is one offer named like the product', () => {
        const simple = build(snapshot({ products: [product('s')], product_translations: [tr('s', SYS, 'Mug')] }));
        assert.equal(simple.families[0].kind, 'simple');
        assert.deepEqual(simple.families[0].offers.map(o => [o.sourceId, o.names]), [['s', { en: 'Mug' }]]);
    });
});

describe('prices', () => {
    const raw = snapshot({
        products: [
            product('gross-shop', { price: price('11.90', '10') }),
            product('derived-net', { price: price(826.77, 694.7647058823529) }),
            product('no-price', { price: null }),
            product('p'),
            variant('v', 'p'),
        ],
    });

    test('every offer keeps both gross and net in minor units, or null when not convertible', () => {
        const r = build(raw);
        assert.deepEqual([offerOf(r, 'gross-shop').priceGrossMinor, offerOf(r, 'gross-shop').priceNetMinor], [1190, 1000]);
        // Shopware stores a net price derived from gross at full float precision; it is not a price.
        assert.deepEqual([offerOf(r, 'derived-net').priceGrossMinor, offerOf(r, 'derived-net').priceNetMinor], [82677, null]);
        assert.equal(offerOf(r, 'v').priceGrossMinor, 1000, 'variant inherits the parent price');
    });

    test('a gross-price shop refuses only offers whose gross price or tax is missing', () => {
        const { problems } = build(raw, { pricesIncludeTax: true });
        assert.deepEqual(problems.refusedOffers.map(o => [o.sku, o.reasons]), [['NO-PRICE', ['no price']]]);
        assert.deepEqual(problems.unpriced, ['NO-PRICE']);
        assert.deepEqual(problems.subCentPrice, []);
    });

    test('a net-price shop refuses offers whose net price is not convertible and names the field', () => {
        const { problems } = build(raw, { pricesIncludeTax: false });
        assert.deepEqual(problems.refusedOffers.map(o => [o.sku, o.reasons]), [
            ['DERIVED-NET', ['net price sub-minor-unit precision']],
            ['NO-PRICE', ['no price']],
        ]);
        assert.deepEqual(problems.subCentPrice, [{ sku: 'DERIVED-NET', field: 'net', value: 694.7647058823529, reason: 'net price sub-minor-unit precision' }]);
    });

    test('an offer without tax after inheritance is refused, with the reason', () => {
        const r = build(snapshot({ products: [product('p', { tax_id: null }), variant('v', 'p')] }));
        assert.deepEqual(r.problems.untaxed, ['V']);
        assert.deepEqual(r.problems.refusedOffers.map(o => [o.sku, o.reasons]), [['V', ['no tax after inheritance']]]);
        assert.equal(offerOf(r, 'v').taxSourceId, null);
    });

    test('invalid price JSON is a problem, not a crash', () => {
        const r = build(snapshot({ products: [product('broken', { price: '{"c' })] }));
        assert.deepEqual(r.problems.invalidPriceJson, ['BROKEN']);
        assert.equal(offerOf(r, 'broken').priceGrossMinor, null);
    });

    test('counts list prices and explicit prices in other currencies', () => {
        const usd = 'c0000usd';
        const withExtras = JSON.stringify({
            [CUR]: { gross: 10, net: 8.4, linked: true, listPrice: { gross: 12, net: 10.08, linked: true } },
            [usd]: { gross: 11, net: 9.24, linked: true },
        });
        const r = build(snapshot({ products: [product('a', { price: withExtras }), product('b')] }));
        assert.deepEqual(r.priceStats, { offersWithListPrice: 1, offersWithOtherCurrencies: 1, otherCurrencyKeys: { [usd]: 1 }, grossNotConvertible: 0, netNotConvertible: 0 });
    });
});
