// Pure resolvers for Shopware's effective values: inheritance between a variant and its parent,
// translation fallback along the language chain, and the grouping of countries into tax zones.
// No I/O and no state, so transform stays a composition of these and each rule can be tested alone.
import { SHOPWARE } from '../config.mjs';

/** Scalar inheritance: own value unless NULL, then parent's. Records provenance. */
export function inherit(own, parent, field) {
    if (own[field] !== null && own[field] !== undefined) return { value: own[field], from: 'own' };
    if (parent && parent[field] !== null && parent[field] !== undefined) return { value: parent[field], from: 'parent' };
    return { value: null, from: 'none' };
}

/** Association inheritance: own rows if the child has any, otherwise the parent's. */
export function inheritRows(index, own, parent) {
    const mine = index.get(own.id) ?? [];
    if (mine.length || !parent) return { rows: mine, from: mine.length ? 'own' : 'none' };
    const theirs = index.get(parent.id) ?? [];
    return { rows: theirs, from: theirs.length ? 'parent' : 'none' };
}

/** Translation rows of one entity keyed by language id. */
export function byLangMap(rows) {
    return new Map(rows.map(r => [r.language_id, r]));
}

/** Shopware's language chain for a context: requested, its parent, then system language. */
export function languageChain(langById, langId, systemLanguageId = SHOPWARE.LANGUAGE_SYSTEM) {
    const l = langById.get(langId);
    return [...new Set([langId, l.parentId, systemLanguageId].filter(Boolean))];
}

/**
 * Effective translated value exactly as Shopware's DAL resolves it for inherited entities:
 * the child's whole language chain first, then the parent's. Returns the value and the
 * language it was authored in, so the loader only writes translations that really exist
 * in that language and lets Vendure's own default-language fallback do the rest.
 *
 * `languages` are `{ sourceId, parentId, code }`; several Shopware languages may share a code,
 * and the first one in list order wins.
 */
export function resolveTranslated(languages, ownByLang, parentByLang, field, systemLanguageId = SHOPWARE.LANGUAGE_SYSTEM) {
    const langById = new Map(languages.map(l => [l.sourceId, l]));
    const out = {};
    for (const lang of languages) {
        for (const [owner, byLang] of [['own', ownByLang], ['parent', parentByLang]]) {
            if (out[lang.code]) break;
            for (const chainLang of languageChain(langById, lang.sourceId, systemLanguageId)) {
                const value = byLang?.get(chainLang)?.[field];
                if (value !== null && value !== undefined && value !== '') {
                    out[lang.code] = { value, authoredIn: langById.get(chainLang).code, owner };
                    break;
                }
            }
        }
    }
    return out;
}

/**
 * Untranslated-fallback lookup for plain translation tables (property groups, options,
 * manufacturers, countries, media): the value of `field` per Vendure language code.
 * @param {Array<{ sourceId: string, code: string }>} languages
 * @param {Array<{ language_id: string }>|undefined} rows Translation rows of one entity.
 * @param {string} field Column to read.
 * @returns {Record<string, unknown>} code -> value. Rows in unknown languages are skipped. Never throws.
 */
export function valuesByCode(languages, rows, field) {
    const codeById = new Map(languages.map(l => [l.sourceId, l.code]));
    const out = {};
    for (const r of rows ?? []) {
        const code = codeById.get(r.language_id);
        if (code) out[code] = r[field];
    }
    return out;
}

/** Keeps only values authored in their own language; the default language is always kept. */
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
