// Pure resolvers for Shopware's effective values: inheritance between a variant and its parent,
// translation fallback along the language chain, and the grouping of countries into tax zones.
// No I/O and no state, so transform stays a composition of these and each rule can be tested alone.
import { SHOPWARE } from '../config.mjs';

/**
 * Scalar inheritance: own value unless NULL, then parent's. Records provenance.
 * @param {object} own The row.
 * @param {object|null} parent The parent row, or null.
 * @param {string} field Column name; a missing column counts as NULL.
 * @returns {{ value: unknown, from: 'own'|'parent'|'none' }} Never throws.
 */
export function inherit(own, parent, field) {
    if (own[field] !== null && own[field] !== undefined) return { value: own[field], from: 'own' };
    if (parent && parent[field] !== null && parent[field] !== undefined) return { value: parent[field], from: 'parent' };
    return { value: null, from: 'none' };
}

/**
 * Association inheritance: own rows if the child has any, otherwise the parent's.
 * @param {Map<string, object[]>} index Rows by owner id. Decide on the complete index and filter
 *   the returned rows afterwards, or a child with only filtered-out rows would wrongly inherit.
 * @param {{ id: string }} own
 * @param {{ id: string }|null} parent
 * @returns {{ rows: object[], from: 'own'|'parent'|'none' }} The index's own arrays; do not mutate them. Never throws.
 */
export function inheritRows(index, own, parent) {
    const mine = index.get(own.id) ?? [];
    if (mine.length || !parent) return { rows: mine, from: mine.length ? 'own' : 'none' };
    const theirs = index.get(parent.id) ?? [];
    return { rows: theirs, from: theirs.length ? 'parent' : 'none' };
}

/**
 * Translation rows of one entity keyed by language id.
 * @param {Array<{ language_id: string }>} rows
 * @returns {Map<string, object>} Never throws.
 */
export function byLangMap(rows) {
    return new Map(rows.map(r => [r.language_id, r]));
}

/**
 * The one rule for several Shopware languages that map to the same Vendure code: the first
 * language in list order owns the code, the others are dropped everywhere (their translation
 * rows are never read). buildLanguages sorts the list with the system language first.
 * @param {Array<{ sourceId: string, code: string }>} languages
 * @returns {{ kept: object[], dropped: Array<{ language: object, keptInstead: object }> }} Order preserved. Never throws.
 */
export function firstLanguagePerCode(languages) {
    const byCode = new Map();
    for (const l of languages) if (!byCode.has(l.code)) byCode.set(l.code, l);
    return {
        kept: languages.filter(l => byCode.get(l.code) === l),
        dropped: languages.filter(l => byCode.get(l.code) !== l).map(l => ({ language: l, keptInstead: byCode.get(l.code) })),
    };
}

/**
 * Shopware's language chain for a context: requested, its parent, then system language.
 * @param {Map<string, { parentId: string|null }>} langById
 * @param {string} langId
 * @param {string} [systemLanguageId]
 * @returns {string[]} Language ids, most specific first, without duplicates.
 * @throws {TypeError} When langId is not in langById.
 */
export function languageChain(langById, langId, systemLanguageId = SHOPWARE.LANGUAGE_SYSTEM) {
    const l = langById.get(langId);
    return [...new Set([langId, l.parentId, systemLanguageId].filter(Boolean))];
}

/**
 * Effective translated value exactly as Shopware's DAL resolves it for inherited entities. The
 * fallback is language-major: for each language of the context chain, from the most specific to
 * the system language, the entity's own translation first, then the parent's, then the next
 * language (EntityDefinitionQueryHelper::buildTranslationChain). So a variant with only an
 * English name shows its parent's German name in German.
 *
 * Returns the value and the language it was authored in, so the loader only writes translations
 * that really exist in that language and lets Vendure's own default-language fallback do the rest.
 *
 * @param {Array<{ sourceId: string, parentId: string|null, code: string }>} languages Several
 *   Shopware languages may share a code; firstLanguagePerCode decides which one is read. The
 *   others still count as links in a language chain.
 * @param {Map<string, object>|null|undefined} ownByLang The entity's translation rows by language id.
 * @param {Map<string, object>|null|undefined} parentByLang The parent entity's rows, or nothing.
 * @param {string} field Column to read. NULL and '' count as not translated.
 * @param {string} [systemLanguageId]
 * @returns {Record<string, { value: unknown, authoredIn: string, owner: 'own'|'parent' }>} Languages
 *   without a value anywhere are left out.
 * @throws {TypeError} When a language's parent is not in `languages`.
 */
export function resolveTranslated(languages, ownByLang, parentByLang, field, systemLanguageId = SHOPWARE.LANGUAGE_SYSTEM) {
    const langById = new Map(languages.map(l => [l.sourceId, l]));
    const sources = [['own', ownByLang], ['parent', parentByLang]];
    const resolveOne = lang => {
        for (const chainLang of languageChain(langById, lang.sourceId, systemLanguageId)) {
            for (const [owner, byLang] of sources) {
                const value = byLang?.get(chainLang)?.[field];
                if (value !== null && value !== undefined && value !== '') {
                    return { value, authoredIn: langById.get(chainLang).code, owner };
                }
            }
        }
        return undefined;
    };
    const out = {};
    for (const lang of firstLanguagePerCode(languages).kept) {
        const hit = resolveOne(lang);
        if (hit) out[lang.code] = hit;
    }
    return out;
}

/**
 * Plain lookup without fallback for translation tables of non-inherited entities (property
 * groups, options, manufacturers, countries, media): the value of `field` per Vendure code.
 * @param {Array<{ sourceId: string, code: string }>} languages
 * @param {Array<{ language_id: string }>|undefined} rows Translation rows of one entity.
 * @param {string} field Column to read.
 * @returns {Record<string, unknown>} code -> value. Rows in unknown languages and in languages
 *   firstLanguagePerCode drops are skipped. Never throws.
 */
export function valuesByCode(languages, rows, field) {
    const codeById = new Map(firstLanguagePerCode(languages).kept.map(l => [l.sourceId, l.code]));
    const out = {};
    for (const r of rows ?? []) {
        const code = codeById.get(r.language_id);
        if (code) out[code] = r[field];
    }
    return out;
}

/**
 * Keeps only values authored in their own language; the default language is always kept.
 * @param {Record<string, { value: unknown, authoredIn: string }>} resolved Output of resolveTranslated.
 * @param {string} defaultLanguageCode
 * @returns {Record<string, unknown>} code -> value. Never throws.
 */
export function authoredOnly(resolved, defaultLanguageCode) {
    const out = {};
    for (const [code, r] of Object.entries(resolved)) {
        if (r.authoredIn === code || code === defaultLanguageCode) out[code] = r.value;
    }
    return out;
}

/**
 * Shopware applies a tax's default rate everywhere except in countries with an `entire_country`
 * tax_rule. Vendure rates belong to zones, so countries with the same rate tuple (one rate per
 * tax category, in category order) share one zone. The zone whose tuple equals the default rates
 * is marked as the default. Other tax_rule types are ignored here; transform reports them as a gap.
 *
 * `countries` are `{ sourceId, code }`, `taxCategories` are `{ sourceId, defaultRate }`.
 */
export function groupTaxZones(countries, taxCategories, taxRules) {
    // Rate per (country, tax): the tax_rule if present, otherwise the tax's default rate.
    const ruleRate = new Map(
        taxRules.filter(r => r.type === 'entire_country').map(r => [`${r.country_id}|${r.tax_id}`, Number(r.tax_rate)]),
    );
    const zoneByTuple = new Map();
    for (const c of countries) {
        const rates = taxCategories.map(t => ruleRate.get(`${c.sourceId}|${t.sourceId}`) ?? t.defaultRate);
        const key = rates.join('/');
        if (!zoneByTuple.has(key)) zoneByTuple.set(key, { key, rates, countryCodes: [] });
        zoneByTuple.get(key).countryCodes.push(c.code);
    }
    const defaultTuple = taxCategories.map(t => t.defaultRate).join('/');
    const taxZones = [...zoneByTuple.values()].map(z => ({
        key: z.key,
        name: `Tax ${z.key} (${z.countryCodes.length} ${z.countryCodes.length === 1 ? 'country' : 'countries'})`,
        countryCodes: z.countryCodes.sort(),
        rates: Object.fromEntries(taxCategories.map((t, i) => [t.sourceId, z.rates[i]])),
        isDefault: z.key === defaultTuple,
    }));
    return { taxZones, defaultTuple };
}
