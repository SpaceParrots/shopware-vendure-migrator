// Shopware languages -> Vendure language codes, and the translation helpers bound to them.
import { authoredOnly, firstLanguagePerCode, resolveTranslated, valuesByCode } from '../lib/resolve.mjs';

// Shopware locale -> Vendure LanguageCode. Base codes on purpose: one storefront per language.
export const LOCALE_TO_LANGUAGE = { 'en-GB': 'en', 'en-US': 'en', 'de-DE': 'de', 'de-AT': 'de', 'de-CH': 'de' };

// Raw tables with a language_id column whose rows a dropped language loses.
const TRANSLATION_TABLES = [
    'product_translations', 'category_translations', 'property_group_translations',
    'property_group_option_translations', 'manufacturer_translations', 'country_translations',
    'media_translations', 'seo_urls',
];

/**
 * Maps the extracted Shopware languages to Vendure codes and binds the translation helpers.
 *
 * The content language of a Shopware language is `translation_code` (language.translation_code_id,
 * "Locale used for translating content"), falling back to `locale` (language.locale_id, the
 * regional formats), exactly as BaseSalesChannelContextFactory::getLanguageInfo does.
 *
 * Languages are ordered system language first, then languages without a parent language before
 * child languages (de-DE before its de-AT child), then by id; firstLanguagePerCode decides which
 * one owns a Vendure code when several map to it.
 * @param {Array<{ id: string, parent_id: string|null, locale: string, translation_code: string|null }>} rawLanguages
 * @param {string} systemLanguageId Shopware's Defaults::LANGUAGE_SYSTEM.
 * @returns {{
 *   languages: Array<{ sourceId: string, parentId: string|null, locale: string, code: string, isSystem: boolean }>,
 *   droppedLanguages: Array<{ language: object, keptInstead: object }>,
 *   langById: Map<string, object>,
 *   defaultLanguageCode: string,
 *   languageCodes: string[],
 *   translated: (ownByLang: Map|null|undefined, parentByLang: Map|null|undefined, field: string) => object,
 *   authored: (resolved: object) => Record<string, unknown>,
 *   namesOf: (rows: object[]|undefined, field?: string) => Record<string, unknown>,
 *   decisions: Array<{ topic: string, text: string }>,
 * }} `langById` holds only kept languages, so rows in a dropped language are skipped wherever it is used.
 * @throws {Error} When a locale has no Vendure language code or the system language is missing.
 */
export function buildLanguages(rawLanguages, systemLanguageId) {
    const all = rawLanguages
        .map(l => {
            const locale = l.translation_code ?? l.locale;
            return { sourceId: l.id, parentId: l.parent_id, locale, code: LOCALE_TO_LANGUAGE[locale], isSystem: l.id === systemLanguageId };
        })
        .toSorted((a, b) =>
            Number(b.isSystem) - Number(a.isSystem)
            || Number(Boolean(a.parentId)) - Number(Boolean(b.parentId))
            || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    const unmapped = all.filter(l => !l.code);
    if (unmapped.length) throw new Error(`No Vendure language for locales: ${unmapped.map(l => l.locale).join(', ')}`);
    const systemLanguage = all.find(l => l.isSystem);
    if (!systemLanguage) throw new Error(`The Shopware system language ${systemLanguageId} is not in the snapshot.`);
    const { kept, dropped } = firstLanguagePerCode(all);
    const defaultLanguageCode = systemLanguage.code;
    const droppedText = dropped.length
        ? ` ${dropped.map(d => `${d.language.locale} (${d.language.sourceId})`).join(', ')} map to a code another language already has and are dropped; their translation rows are counted in gaps.languages.`
        : '';
    return {
        languages: all,
        droppedLanguages: dropped,
        langById: new Map(kept.map(l => [l.sourceId, l])),
        defaultLanguageCode,
        languageCodes: kept.map(l => l.code),
        translated: (ownByLang, parentByLang, field) => resolveTranslated(all, ownByLang, parentByLang, field, systemLanguageId),
        authored: resolved => authoredOnly(resolved, defaultLanguageCode),
        namesOf: (rows, field = 'name') => valuesByCode(all, rows, field),
        decisions: [
            {
                topic: 'languages',
                text: `Shopware system language ${systemLanguage.locale} becomes Vendure default language "${defaultLanguageCode}". A language's content locale is its translation code, else its locale; locales map to base codes (${all.map(l => `${l.locale}->${l.code}`).join(', ')}). When several languages map to one code, the system language wins, then a language without parent language, then the lowest id.${droppedText}`,
            },
        ],
    };
}

/**
 * Translation rows the migration ignores because their language was dropped.
 * @param {object} raw Snapshot tables.
 * @param {Array<{ language: { sourceId: string, locale: string, code: string }, keptInstead: { locale: string } }>} droppedLanguages
 * @returns {{ verdict: string, droppedLanguages: object[], droppedRows: Record<string, number> }} Never throws.
 */
export function languageGaps(raw, droppedLanguages) {
    const ids = new Set(droppedLanguages.map(d => d.language.sourceId));
    return {
        verdict: 'when several Shopware languages map to one Vendure language code, only the first (system language, then languages without parent language, then lowest id) is migrated',
        droppedLanguages: droppedLanguages.map(d => ({ sourceId: d.language.sourceId, locale: d.language.locale, code: d.language.code, keptLocale: d.keptInstead.locale })),
        droppedRows: Object.fromEntries(TRANSLATION_TABLES.map(t => [t, (raw[t] ?? []).filter(r => ids.has(r.language_id)).length])),
    };
}
