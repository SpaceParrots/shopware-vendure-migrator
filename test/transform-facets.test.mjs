// Facet names are shop-visible text: a German shop must not get a filter labelled in English only,
// and a shop in another language must still have a name in its default language.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manufacturerFacetNames } from '../src/transform/facets.mjs';

describe('manufacturerFacetNames', () => {
    test('names the facet in every shop language that has a label', () => {
        assert.deepEqual(manufacturerFacetNames(['en', 'de'], 'en'), { en: 'Manufacturer', de: 'Hersteller' });
    });

    test('adds no name for languages the shop does not have', () => {
        assert.deepEqual(manufacturerFacetNames(['de'], 'de'), { de: 'Hersteller' });
    });

    test('the default language always gets a name, English when it has no label', () => {
        assert.deepEqual(manufacturerFacetNames(['fr', 'de'], 'fr'), { fr: 'Manufacturer', de: 'Hersteller' });
    });

    test('other languages without a label are left to Vendure\'s default-language fallback', () => {
        assert.deepEqual(manufacturerFacetNames(['en', 'nl'], 'en'), { en: 'Manufacturer' });
    });
});
