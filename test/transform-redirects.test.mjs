// Every old Shopware URL must land on the page Vendure really serves, or the shop loses its search
// traffic on the day of the switch.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildRedirects, redirectsCsv } from '../src/transform/redirects.mjs';
import { slugFromSeoOrName, uniqueSlugsPerLanguage } from '../src/transform/slugs.mjs';

const SF = 'sf';
const EN = 'lang-en';
const DE = 'lang-de';
const ctx = {
    storefront: { id: SF },
    langById: new Map([[EN, { code: 'en' }], [DE, { code: 'de' }]]),
    defaultLanguageCode: 'en',
};
const seo = (foreign_key, seo_path_info, extra = {}) => ({
    foreign_key, seo_path_info, language_id: EN, sales_channel_id: SF, route_name: 'frontend.detail.page', ...extra,
});
const families = [
    { sourceId: 'simple', kind: 'simple', slugs: { en: 'mug' }, offers: [{ sourceId: 'simple' }] },
    { sourceId: 'hoodie', kind: 'family', slugs: { en: 'hoodie', de: 'kapuzenpulli' }, offers: [{ sourceId: 'hoodie-red' }, { sourceId: 'hoodie-blue' }] },
];
const collections = [{ sourceId: 'cat', slugs: { en: 'clothing' } }];

describe('buildRedirects', () => {
    test('products and categories redirect to their slug in the SEO URL language', () => {
        const { redirects } = buildRedirects({
            seoUrls: [seo('hoodie', 'Hoodie/H1', { language_id: DE }), seo('cat', 'Clothing/', { route_name: 'frontend.navigation.page' })],
            families, collections, ctx,
        });
        assert.deepEqual(redirects, [
            { type: 'product', sourceId: 'hoodie', language: 'de', from: '/Hoodie/H1', toSlug: 'kapuzenpulli' },
            { type: 'category', sourceId: 'cat', language: 'en', from: '/Clothing/', toSlug: 'clothing' },
        ]);
    });

    test('a variant SEO URL redirects to the family slug', () => {
        const { redirects } = buildRedirects({ seoUrls: [seo('hoodie-red', 'Hoodie/H1.1')], families, collections, ctx });
        assert.deepEqual(redirects, [{ type: 'variant', sourceId: 'hoodie-red', language: 'en', from: '/Hoodie/H1.1', toSlug: 'hoodie' }]);
    });

    test('a language without own slug redirects to the default-language slug', () => {
        const { redirects } = buildRedirects({ seoUrls: [seo('simple', 'Becher/M1', { language_id: DE })], families, collections, ctx });
        assert.deepEqual(redirects.map(r => [r.language, r.toSlug]), [['de', 'mug']]);
    });

    test('SEO URLs of unknown entities are counted, other channels and dropped languages ignored', () => {
        const { redirects, unmatched } = buildRedirects({
            seoUrls: [
                seo('gone', 'Gone/1'),
                seo('link-cat', 'Link/', { route_name: 'frontend.navigation.page' }),
                seo('simple', 'Other/1', { sales_channel_id: 'headless' }),
                seo('simple', 'Dropped/1', { language_id: 'lang-dropped' }),
            ],
            families, collections, ctx,
        });
        assert.deepEqual(redirects, []);
        assert.deepEqual(unmatched, { products: 1, categories: 1 });
    });
});

describe('slugs', () => {
    test('the SEO path wins over the name', () => {
        const slugOf = slugFromSeoOrName(new Map([['p|en', 'Main-product/SW1']]));
        assert.equal(slugOf('p', 'en', 'Main product'), 'main-product-sw1');
        assert.equal(slugOf('p', 'de', 'Hauptprodukt'), 'hauptprodukt');
    });

    test('duplicates get numbered per language, in list order, without touching the input', () => {
        const input = [{ id: 1, slugs: { en: 'shirt', de: 'hemd' } }, { id: 2, slugs: { en: 'shirt', de: 'shirt' } }, { id: 3, slugs: { en: 'shirt', de: '' } }];
        const before = structuredClone(input);
        const out = uniqueSlugsPerLanguage(input);
        assert.deepEqual(out.map(e => e.slugs), [{ en: 'shirt', de: 'hemd' }, { en: 'shirt-2', de: 'shirt' }, { en: 'shirt-3', de: 'item' }]);
        assert.deepEqual(input, before);
    });

    test('redirects point at the unique slug', () => {
        const [first, second] = uniqueSlugsPerLanguage([
            { sourceId: 'a', kind: 'simple', slugs: { en: 'shirt' }, offers: [] },
            { sourceId: 'b', kind: 'simple', slugs: { en: 'shirt' }, offers: [] },
        ]);
        const { redirects } = buildRedirects({ seoUrls: [seo('b', 'Shirt/B')], families: [first, second], collections: [], ctx });
        assert.equal(redirects[0].toSlug, 'shirt-2');
    });
});

describe('redirectsCsv', () => {
    test('quotes paths that contain commas', () => {
        const csv = redirectsCsv([{ type: 'product', sourceId: 'p', language: 'en', from: '/a,b', toSlug: 'ab' }]);
        assert.equal(csv, 'type,sourceId,language,from,toSlug\r\nproduct,p,en,"/a,b",ab\r\n');
    });
});
