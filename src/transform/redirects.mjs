// Shopware SEO URLs -> redirect list (old path -> Vendure slug).
import { toCsv } from '../lib/util.mjs';

const DETAIL = 'frontend.detail.page';
const NAVIGATION = 'frontend.navigation.page';

/**
 * Canonical storefront SEO paths of one route, keyed by `${foreignKey}|${code}`.
 * @param {Array<{ foreign_key: string, language_id: string, sales_channel_id: string, route_name: string, seo_path_info: string }>} seoUrls
 * @param {string} routeName 'frontend.detail.page' or 'frontend.navigation.page'.
 * @param {{ storefront: { id: string }, langById: Map<string, { code: string }> }} ctx
 * @returns {Map<string, string>} Never throws; rows in unknown or dropped languages are skipped.
 */
export function seoPaths(seoUrls, routeName, { storefront, langById }) {
    return new Map(
        seoUrls
            .filter(s => s.route_name === routeName && s.sales_channel_id === storefront.id && langById.has(s.language_id))
            .map(s => [`${s.foreign_key}|${langById.get(s.language_id).code}`, s.seo_path_info]),
    );
}

/**
 * One redirect per canonical storefront SEO URL: products, variants (to their family's slug, since
 * a Vendure variant has no page of its own) and categories. A language without its own slug (its
 * name fell back to the default language) redirects to the default-language slug, which is the
 * slug Vendure serves for it.
 * @param {object} input
 * @param {object[]} input.seoUrls Rows of raw/seo_urls.json.
 * @param {object[]} input.families Families with final (unique) slugs.
 * @param {object[]} input.collections Collections with final (unique) slugs.
 * @param {{ storefront: { id: string }, langById: Map<string, { code: string }>, defaultLanguageCode: string }} input.ctx
 * @returns {{
 *   redirects: Array<{ type: 'product'|'variant'|'category', sourceId: string, language: string, from: string, toSlug: string }>,
 *   unmatched: { products: number, categories: number },
 * }} unmatched counts SEO URLs whose entity is not in the model (e.g. link categories) or has no slug. Never throws.
 */
export function buildRedirects({ seoUrls, families, collections, ctx }) {
    const { storefront, langById, defaultLanguageCode } = ctx;
    const familyById = new Map(families.map(f => [f.sourceId, f]));
    const familyOfVariant = new Map(families.filter(f => f.kind === 'family').flatMap(f => f.offers.map(o => [o.sourceId, f])));
    const collectionById = new Map(collections.map(c => [c.sourceId, c]));
    const targetOf = s => {
        if (s.route_name === NAVIGATION) return collectionById.has(s.foreign_key) ? ['category', collectionById.get(s.foreign_key)] : ['category', null];
        if (familyById.has(s.foreign_key)) return ['product', familyById.get(s.foreign_key)];
        return ['variant', familyOfVariant.get(s.foreign_key) ?? null];
    };

    const results = seoUrls
        .filter(s => (s.route_name === DETAIL || s.route_name === NAVIGATION) && s.sales_channel_id === storefront.id && langById.has(s.language_id))
        .map(s => {
            const code = langById.get(s.language_id).code;
            const [type, target] = targetOf(s);
            const toSlug = target ? target.slugs[code] ?? target.slugs[defaultLanguageCode] : undefined;
            return { route: s.route_name, redirect: toSlug ? { type, sourceId: s.foreign_key, language: code, from: `/${s.seo_path_info}`, toSlug } : null };
        });
    const missing = route => results.filter(r => r.route === route && !r.redirect).length;
    return {
        redirects: results.filter(r => r.redirect).map(r => r.redirect),
        unmatched: { products: missing(DETAIL), categories: missing(NAVIGATION) },
    };
}

/**
 * @param {Array<{ type: string, sourceId: string, language: string, from: string, toSlug: string }>} redirects
 * @returns {string} redirects.csv content (RFC 4180). Never throws.
 */
export function redirectsCsv(redirects) {
    return toCsv(['type', 'sourceId', 'language', 'from', 'toSlug'], redirects.map(r => [r.type, r.sourceId, r.language, r.from, r.toSlug]));
}
