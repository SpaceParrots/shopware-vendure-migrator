// URL slugs for products and collections.
import { slugify, uniqueCoder } from '../lib/util.mjs';

/**
 * Slug lookup: the storefront SEO path of the entity in that language when there is one,
 * otherwise the slugified name.
 * @param {Map<string, string>} seoPathByKey `${sourceId}|${code}` -> seo_path_info.
 * @returns {(sourceId: string, code: string, name: string) => string} Never throws.
 */
export function slugFromSeoOrName(seoPathByKey) {
    return (id, code, name) => {
        const seo = seoPathByKey.get(`${id}|${code}`);
        return seo ? slugify(seo) : slugify(name);
    };
}

/**
 * Makes slugs unique per language across a list of entities, in list order: the first entity
 * keeps its slug, later ones get `-2`, `-3`, and so on (an empty slug becomes `item`). Vendure
 * rejects or rewrites a duplicate slug, so without this redirects.csv would point at a slug
 * Vendure does not store.
 * @template {{ slugs: Record<string, string> }} T
 * @param {T[]} entities
 * @returns {T[]} New objects with unique slugs; the input is not modified. Never throws.
 */
export function uniqueSlugsPerLanguage(entities) {
    const coders = new Map();
    const coderFor = code => {
        if (!coders.has(code)) coders.set(code, uniqueCoder());
        return coders.get(code);
    };
    return entities.map(e => ({
        ...e,
        slugs: Object.fromEntries(Object.entries(e.slugs).map(([code, slug]) => [code, coderFor(code)(slug)])),
    }));
}
