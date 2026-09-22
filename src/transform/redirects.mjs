// Shopware SEO URLs -> redirect list (old path -> Vendure slug).
import { toCsv } from '../lib/util.mjs';

/**
 * Canonical storefront SEO paths of one route, keyed by `${foreignKey}|${code}`.
 * @param {Array<{ foreign_key: string, language_id: string, sales_channel_id: string, route_name: string, seo_path_info: string }>} seoUrls
 * @param {string} routeName 'frontend.detail.page' or 'frontend.navigation.page'.
 * @param {{ storefront: { id: string }, langById: Map<string, { code: string }> }} ctx
 * @returns {Map<string, string>} Never throws; rows in unknown languages are skipped.
 */
export function seoPaths(seoUrls, routeName, { storefront, langById }) {
    return new Map(
        seoUrls
            .filter(s => s.route_name === routeName && s.sales_channel_id === storefront.id && langById.has(s.language_id))
            .map(s => [`${s.foreign_key}|${langById.get(s.language_id).code}`, s.seo_path_info]),
    );
}

/**
 * One redirect per product and category SEO URL that has a target slug.
 * @param {{ families: object[], collections: object[], productSeo: Map<string, string>, categorySeo: Map<string, string> }} input
 * @returns {Array<{ type: string, sourceId: string, language: string, from: string, toSlug: string }>} Never throws.
 */
export function buildRedirects({ families, collections, productSeo, categorySeo }) {
    const of = (type, seo) => entity => Object.entries(entity.slugs).flatMap(([code, toSlug]) => {
        const path = seo.get(`${entity.sourceId}|${code}`);
        return path ? [{ type, sourceId: entity.sourceId, language: code, from: `/${path}`, toSlug }] : [];
    });
    return [...families.flatMap(of('product', productSeo)), ...collections.flatMap(of('category', categorySeo))];
}

/**
 * @param {Array<{ type: string, sourceId: string, language: string, from: string, toSlug: string }>} redirects
 * @returns {string} redirects.csv content (RFC 4180). Never throws.
 */
export function redirectsCsv(redirects) {
    return toCsv(['type', 'sourceId', 'language', 'from', 'toSlug'], redirects.map(r => [r.type, r.sourceId, r.language, r.from, r.toSlug]));
}
