// Several Shopware languages can land on one Vendure code (en-GB and en-US both become "en").
// Which one wins must not depend on row order, and the losers must show up as a gap.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { byLangMap, firstLanguagePerCode } from '../src/lib/resolve.mjs';
import { buildLanguages, languageGaps } from '../src/transform/languages.mjs';

const SYS = 'ffff-system';
const lang = (id, locale, extra = {}) => ({ id, parent_id: null, locale, translation_code: null, ...extra });

describe('firstLanguagePerCode', () => {
    test('keeps the first language per code and says which one each dropped language lost to', () => {
        const a = { sourceId: 'a', code: 'en' };
        const b = { sourceId: 'b', code: 'de' };
        const c = { sourceId: 'c', code: 'en' };
        assert.deepEqual(firstLanguagePerCode([a, b, c]), { kept: [a, b], dropped: [{ language: c, keptInstead: a }] });
    });
});

describe('buildLanguages', () => {
    test('puts the system language first, then root languages, then child languages, each by id', () => {
        const rows = [lang('b-de', 'de-DE'), lang('0-at', 'de-AT', { parent_id: 'b-de' }), lang(SYS, 'en-GB'), lang('a-de', 'de-DE')];
        const result = buildLanguages(rows, SYS);
        assert.deepEqual(result.languages.map(l => l.sourceId), [SYS, 'a-de', 'b-de', '0-at']);
        assert.deepEqual(result.languageCodes, ['en', 'de']);
        assert.equal(result.defaultLanguageCode, 'en');
    });

    test('a later language with the same code is dropped, even when it has an id lower than the system language', () => {
        const result = buildLanguages([lang('0000-us', 'en-US'), lang(SYS, 'en-GB')], SYS);
        assert.deepEqual(result.droppedLanguages.map(d => [d.language.sourceId, d.keptInstead.sourceId]), [['0000-us', SYS]]);
        assert.deepEqual([...result.langById.keys()], [SYS]);
    });

    test('dropped languages are never read, not even when the kept one has no value', () => {
        const result = buildLanguages([lang(SYS, 'en-GB'), lang('de-de', 'de-DE'), lang('de-at', 'de-AT', { parent_id: 'de-de' })], SYS);
        assert.deepEqual(result.namesOf([{ language_id: 'de-at', name: 'Jänner' }]), {});
        const resolved = result.translated(byLangMap([{ language_id: SYS, name: 'January' }, { language_id: 'de-at', name: 'Jänner' }]), null, 'name');
        assert.deepEqual(resolved.de, { value: 'January', authoredIn: 'en', owner: 'own' });
    });

    test('the content language comes from the translation code, not the regional locale', () => {
        // A language with Swiss French regional formats whose content is written in German.
        const result = buildLanguages([lang(SYS, 'en-GB'), lang('x', 'fr-CH', { translation_code: 'de-DE' })], SYS);
        assert.deepEqual(result.languages.map(l => [l.locale, l.code]), [['en-GB', 'en'], ['de-DE', 'de']]);
    });

    test('fails on a locale without Vendure language and on a missing system language', () => {
        assert.throws(() => buildLanguages([lang(SYS, 'en-GB'), lang('x', 'xx-XX')], SYS), /No Vendure language for locales: xx-XX/);
        assert.throws(() => buildLanguages([lang('x', 'en-GB')], SYS), /system language ffff-system is not in the snapshot/);
    });
});

describe('languageGaps', () => {
    test('counts the translation rows of dropped languages per table', () => {
        const { droppedLanguages } = buildLanguages([lang(SYS, 'en-GB'), lang('us', 'en-US')], SYS);
        const raw = {
            product_translations: [{ language_id: SYS }, { language_id: 'us' }, { language_id: 'us' }],
            seo_urls: [{ language_id: 'us' }],
        };
        const gaps = languageGaps(raw, droppedLanguages);
        assert.deepEqual(gaps.droppedLanguages, [{ sourceId: 'us', locale: 'en-US', code: 'en', keptLocale: 'en-GB' }]);
        assert.equal(gaps.droppedRows.product_translations, 2);
        assert.equal(gaps.droppedRows.seo_urls, 1);
        assert.equal(gaps.droppedRows.category_translations, 0);
    });
});
