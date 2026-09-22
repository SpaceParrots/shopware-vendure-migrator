// Shopware languages -> Vendure language codes, and the translation helpers bound to them.
import { authoredOnly, resolveTranslated, valuesByCode } from '../lib/resolve.mjs';

// Shopware locale -> Vendure LanguageCode. Base codes on purpose: one storefront per language.
export const LOCALE_TO_LANGUAGE = { 'en-GB': 'en', 'en-US': 'en', 'de-DE': 'de', 'de-AT': 'de', 'de-CH': 'de' };

/**
 * Maps the extracted Shopware languages to Vendure codes and binds the translation helpers.
 * @param {Array<{ id: string, parent_id: string|null, locale: string }>} rawLanguages Rows of raw/languages.json.
 * @param {string} systemLanguageId Shopware's Defaults::LANGUAGE_SYSTEM.
 * @returns {{
 *   languages: Array<{ sourceId: string, parentId: string|null, locale: string, code: string, isSystem: boolean }>,
 *   langById: Map<string, object>,
 *   defaultLanguageCode: string,
 *   languageCodes: string[],
 *   translated: (ownByLang: Map|null|undefined, parentByLang: Map|null|undefined, field: string) => object,
 *   authored: (resolved: object) => Record<string, unknown>,
 *   namesOf: (rows: object[]|undefined, field?: string) => Record<string, unknown>,
 *   decisions: Array<{ topic: string, text: string }>,
 * }}
 * @throws {Error} When a locale has no Vendure language code or the system language is missing.
 */
export function buildLanguages(rawLanguages, systemLanguageId) {
    const languages = rawLanguages.map(l => ({
        sourceId: l.id,
        parentId: l.parent_id,
        locale: l.locale,
        code: LOCALE_TO_LANGUAGE[l.locale],
        isSystem: l.id === systemLanguageId,
    }));
    const unmapped = languages.filter(l => !l.code);
    if (unmapped.length) throw new Error(`No Vendure language for locales: ${unmapped.map(l => l.locale).join(', ')}`);
    const systemLanguage = languages.find(l => l.isSystem);
    if (!systemLanguage) throw new Error(`The Shopware system language ${systemLanguageId} is not in the snapshot.`);
    const langById = new Map(languages.map(l => [l.sourceId, l]));
    const defaultLanguageCode = systemLanguage.code;
    return {
        languages,
        langById,
        defaultLanguageCode,
        languageCodes: [...new Set(languages.map(l => l.code))],
        translated: (ownByLang, parentByLang, field) => resolveTranslated(languages, ownByLang, parentByLang, field, systemLanguageId),
        authored: resolved => authoredOnly(resolved, defaultLanguageCode),
        namesOf: (rows, field = 'name') => valuesByCode(languages, rows, field),
        decisions: [
            {
                topic: 'languages',
                text: `Shopware system language ${systemLanguage.locale} becomes Vendure default language "${defaultLanguageCode}". Locales map to base codes (${languages.map(l => `${l.locale}->${l.code}`).join(', ')}).`,
            },
        ],
    };
}
