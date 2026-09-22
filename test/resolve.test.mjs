// The resolvers encode Shopware's own rules for inheritance, translation fallback and tax. A
// mistake here does not crash anything; it silently migrates the wrong price or name, so each
// rule is pinned with the edge cases the source data really has.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    authoredOnly,
    byLangMap,
    groupTaxZones,
    inherit,
    inheritRows,
    languageChain,
    resolveTranslated,
} from '../src/lib/resolve.mjs';

describe('inherit (scalar fields)', () => {
    test('own value wins over the parent', () => {
        assert.deepEqual(inherit({ tax_id: 'a' }, { tax_id: 'b' }, 'tax_id'), { value: 'a', from: 'own' });
    });

    test('NULL on the child falls back to the parent', () => {
        assert.deepEqual(inherit({ tax_id: null }, { tax_id: 'b' }, 'tax_id'), { value: 'b', from: 'parent' });
    });

    test('a missing field counts as NULL', () => {
        assert.deepEqual(inherit({}, { tax_id: 'b' }, 'tax_id'), { value: 'b', from: 'parent' });
    });

    test('empty string is a value, not NULL, so it is not inherited', () => {
        assert.deepEqual(inherit({ ean: '' }, { ean: '123' }, 'ean'), { value: '', from: 'own' });
    });

    test('0 and false are values, not NULL', () => {
        assert.deepEqual(inherit({ active: 0 }, { active: 1 }, 'active'), { value: 0, from: 'own' });
        assert.deepEqual(inherit({ active: false }, { active: true }, 'active'), { value: false, from: 'own' });
    });

    test('NULL on both sides resolves to none', () => {
        assert.deepEqual(inherit({ price: null }, { price: null }, 'price'), { value: null, from: 'none' });
    });

    test('a product without parent and NULL resolves to none', () => {
        assert.deepEqual(inherit({ price: null }, null, 'price'), { value: null, from: 'none' });
    });
});

describe('inheritRows (associations)', () => {
    const index = new Map([
        ['parent', [{ category_id: 'c1' }, { category_id: 'c2' }]],
        ['child-own', [{ category_id: 'c3' }]],
    ]);

    test('a child with own rows keeps only its own rows', () => {
        assert.deepEqual(inheritRows(index, { id: 'child-own' }, { id: 'parent' }), {
            rows: [{ category_id: 'c3' }],
            from: 'own',
        });
    });

    test('a child without rows takes the parent rows as a whole', () => {
        assert.deepEqual(inheritRows(index, { id: 'child-none' }, { id: 'parent' }), {
            rows: [{ category_id: 'c1' }, { category_id: 'c2' }],
            from: 'parent',
        });
    });

    test('a child with an empty own list also inherits', () => {
        const withEmpty = new Map([...index, ['child-empty', []]]);
        assert.equal(inheritRows(withEmpty, { id: 'child-empty' }, { id: 'parent' }).from, 'parent');
    });

    test('no rows on either side resolves to none', () => {
        assert.deepEqual(inheritRows(index, { id: 'x' }, { id: 'parent-without-rows' }), { rows: [], from: 'none' });
    });

    test('a product without parent and without rows resolves to none', () => {
        assert.deepEqual(inheritRows(index, { id: 'x' }, null), { rows: [], from: 'none' });
    });
});

// System language en-GB, German de-DE, and Swiss German de-CH whose parent language is de-DE.
// Codes are kept distinct here so each fallback step is visible in the result.
const SYSTEM = 'sys-en';
const languages = [
    { sourceId: SYSTEM, parentId: null, code: 'en' },
    { sourceId: 'de-de', parentId: null, code: 'de' },
    { sourceId: 'de-ch', parentId: 'de-de', code: 'ch' },
];
const rows = (...list) => byLangMap(list.map(([language_id, name]) => ({ language_id, name })));
const resolve = (own, parent, field = 'name') => resolveTranslated(languages, own, parent, field, SYSTEM);

describe('languageChain', () => {
    const langById = new Map(languages.map(l => [l.sourceId, l]));

    test('a root language falls back to the system language', () => {
        assert.deepEqual(languageChain(langById, 'de-de', SYSTEM), ['de-de', SYSTEM]);
    });

    test('a child language goes through its parent language first', () => {
        assert.deepEqual(languageChain(langById, 'de-ch', SYSTEM), ['de-ch', 'de-de', SYSTEM]);
    });

    test('the system language appears once', () => {
        assert.deepEqual(languageChain(langById, SYSTEM, SYSTEM), [SYSTEM]);
    });
});

describe('resolveTranslated', () => {
    test('each language takes its own translation when there is one', () => {
        assert.deepEqual(resolve(rows([SYSTEM, 'Shirt'], ['de-de', 'Hemd']), null), {
            en: { value: 'Shirt', authoredIn: 'en', owner: 'own' },
            de: { value: 'Hemd', authoredIn: 'de', owner: 'own' },
            ch: { value: 'Hemd', authoredIn: 'de', owner: 'own' },
        });
    });

    test('a missing translation falls back to the system language and says so', () => {
        assert.deepEqual(resolve(rows([SYSTEM, 'Shirt']), null).de, { value: 'Shirt', authoredIn: 'en', owner: 'own' });
    });

    test('a translation authored in the parent language is used for the child language', () => {
        // de-CH has no row; Shopware reads de-DE before the system language.
        assert.deepEqual(resolve(rows([SYSTEM, 'Shirt'], ['de-de', 'Hemd']), null).ch, {
            value: 'Hemd',
            authoredIn: 'de',
            owner: 'own',
        });
    });

    test('NULL and empty string both count as not translated', () => {
        const result = resolve(rows([SYSTEM, 'Shirt'], ['de-de', null], ['de-ch', '']), null);
        assert.equal(result.de.authoredIn, 'en');
        assert.equal(result.ch.authoredIn, 'en');
    });

    test('the fallback is language-major: the parent translation in a language beats the child in the next language', () => {
        // Shopware's COALESCE chain (EntityDefinitionQueryHelper::buildTranslationChain) is, per
        // language from specific to system: own translation, then the parent's. The variant has only
        // an English name, the parent a German one, so German shows the parent's German name.
        const result = resolve(rows([SYSTEM, 'Variant']), rows([SYSTEM, 'Parent'], ['de-de', 'Eltern']));
        assert.deepEqual(result.de, { value: 'Eltern', authoredIn: 'de', owner: 'parent' });
        assert.deepEqual(result.en, { value: 'Variant', authoredIn: 'en', owner: 'own' });
    });

    test('language-major also holds along a child language chain', () => {
        // de-CH -> de-DE -> system. The variant has de-DE, the parent de-CH: in de-CH the parent's
        // de-CH row comes before the variant's de-DE row.
        const result = resolve(rows([SYSTEM, 'Variant'], ['de-de', 'Variante']), rows([SYSTEM, 'Parent'], ['de-ch', 'Eltern CH']));
        assert.deepEqual(result.ch, { value: 'Eltern CH', authoredIn: 'ch', owner: 'parent' });
        assert.deepEqual(result.de, { value: 'Variante', authoredIn: 'de', owner: 'own' });
    });

    test('the child translation wins over the parent translation in the same language', () => {
        const result = resolve(rows([SYSTEM, 'Variant'], ['de-de', 'Variante']), rows([SYSTEM, 'Parent'], ['de-de', 'Eltern']));
        assert.deepEqual(result.de, { value: 'Variante', authoredIn: 'de', owner: 'own' });
    });

    test('a child product without any translation takes the parent product value', () => {
        const result = resolve(rows(), rows([SYSTEM, 'Parent'], ['de-de', 'Eltern']));
        assert.deepEqual(result.en, { value: 'Parent', authoredIn: 'en', owner: 'parent' });
        assert.deepEqual(result.de, { value: 'Eltern', authoredIn: 'de', owner: 'parent' });
    });

    test('no value anywhere leaves the language out', () => {
        assert.deepEqual(resolve(rows([SYSTEM, null]), null), {});
        assert.deepEqual(resolve(undefined, undefined), {});
    });

    test('the requested field is read, not the whole row', () => {
        const own = byLangMap([{ language_id: SYSTEM, name: 'Shirt', description: 'Cotton' }]);
        assert.equal(resolve(own, null, 'description').en.value, 'Cotton');
    });

    test('when two languages share a code, the first one in list order wins', () => {
        const twoEnglish = [
            { sourceId: SYSTEM, parentId: null, code: 'en' },
            { sourceId: 'en-us', parentId: null, code: 'en' },
        ];
        const result = resolveTranslated(twoEnglish, rows([SYSTEM, 'Colour'], ['en-us', 'Color']), null, 'name', SYSTEM);
        assert.equal(result.en.value, 'Colour');
    });
});

describe('authoredOnly', () => {
    test('keeps values authored in their own language and always the default language', () => {
        const resolved = {
            en: { value: 'Shirt', authoredIn: 'en', owner: 'own' },
            de: { value: 'Shirt', authoredIn: 'en', owner: 'own' },
            ch: { value: 'Hemd', authoredIn: 'de', owner: 'own' },
        };
        // de and ch were only fallbacks; Vendure's own fallback to the default language gives the same text.
        assert.deepEqual(authoredOnly(resolved, 'en'), { en: 'Shirt' });
    });

    test('keeps the default language even when its value came from elsewhere', () => {
        assert.deepEqual(authoredOnly({ de: { value: 'Shirt', authoredIn: 'en', owner: 'own' } }, 'de'), { de: 'Shirt' });
    });
});

describe('groupTaxZones', () => {
    const taxCategories = [
        { sourceId: 'standard', defaultRate: 19 },
        { sourceId: 'reduced', defaultRate: 7 },
    ];
    const countries = [
        { sourceId: 'de', code: 'DE' },
        { sourceId: 'at', code: 'AT' },
        { sourceId: 'ch', code: 'CH' },
        { sourceId: 'be', code: 'BE' },
    ];
    const rule = (country_id, tax_id, tax_rate, type = 'entire_country') => ({ country_id, tax_id, tax_rate, type });

    test('a country without tax_rule gets the default rates, a country with one gets the rule rate', () => {
        const { taxZones, defaultTuple } = groupTaxZones(countries, taxCategories, [
            rule('at', 'standard', '20.00'),
            rule('at', 'reduced', '10.00'),
            rule('ch', 'standard', '8.1'),
        ]);
        assert.equal(defaultTuple, '19/7');
        assert.deepEqual(taxZones, [
            { key: '19/7', name: 'Tax 19/7 (2 countries)', countryCodes: ['BE', 'DE'], rates: { standard: 19, reduced: 7 }, isDefault: true },
            { key: '20/10', name: 'Tax 20/10 (1 country)', countryCodes: ['AT'], rates: { standard: 20, reduced: 10 }, isDefault: false },
            // Only the standard rate has a rule; the reduced rate stays at the default.
            { key: '8.1/7', name: 'Tax 8.1/7 (1 country)', countryCodes: ['CH'], rates: { standard: 8.1, reduced: 7 }, isDefault: false },
        ]);
    });

    test('countries with the same rate tuple share one zone, whatever the rule says', () => {
        const { taxZones } = groupTaxZones(countries, taxCategories, [rule('at', 'standard', '19')]);
        assert.equal(taxZones.length, 1);
        assert.deepEqual(taxZones[0].countryCodes, ['AT', 'BE', 'CH', 'DE']);
    });

    test('tax_rules that do not cover an entire country are ignored', () => {
        const { taxZones } = groupTaxZones(countries, taxCategories, [rule('at', 'standard', '5', 'individual_states')]);
        assert.equal(taxZones.length, 1);
    });

    test('no zone is the default when every country has a rule', () => {
        const all = countries.flatMap(c => [rule(c.sourceId, 'standard', '21'), rule(c.sourceId, 'reduced', '6')]);
        const { taxZones } = groupTaxZones(countries, taxCategories, all);
        assert.deepEqual(taxZones.map(z => [z.key, z.isDefault]), [['21/6', false]]);
    });
});
