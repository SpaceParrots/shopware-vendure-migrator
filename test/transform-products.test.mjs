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

function build(raw) {
    const lang = buildLanguages(raw.languages, SYS);
    return buildFamilies(raw, { ...lang, storefront: { id: SF }, productSlugOf: (id, code, name) => `${id}-${code}` });
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

    test('a product without variants is one offer named like the product', () => {
        const simple = build(snapshot({ products: [product('s')], product_translations: [tr('s', SYS, 'Mug')] }));
        assert.equal(simple.families[0].kind, 'simple');
        assert.deepEqual(simple.families[0].offers.map(o => [o.sourceId, o.names]), [['s', { en: 'Mug' }]]);
    });
});
