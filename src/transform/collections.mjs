// Shopware categories -> Vendure collections: tree order, link categories, membership.
import { byLangMap } from '../lib/resolve.mjs';
import { groupBy } from '../lib/util.mjs';

/**
 * Depth-first category order with siblings in Shopware's order. Shopware stores sibling order as
 * a linked list: each category names the sibling it comes after (`after_category_id`, NULL for
 * the first). Siblings the chain does not reach (a broken or cyclic chain) follow in id order,
 * so none is lost.
 * @param {Array<{ id: string, parent_id: string|null, after_category_id: string|null }>} categories
 * @returns {object[]} The same row objects in tree order; the input array is not modified. Never throws.
 */
export function orderCategories(categories) {
    const siblingsOf = groupBy(categories, c => c.parent_id ?? null);
    const visit = parentKey => {
        const siblings = siblingsOf.get(parentKey) ?? [];
        const byAfter = new Map(siblings.map(s => [s.after_category_id ?? 'first', s]));
        const chain = [];
        const seen = new Set();
        for (let cursor = byAfter.get('first'); cursor && !seen.has(cursor.id); cursor = byAfter.get(cursor.id)) {
            chain.push(cursor);
            seen.add(cursor.id);
        }
        const rest = siblings.filter(s => !seen.has(s.id)).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return [...chain, ...rest].flatMap(s => [s, ...visit(s.id)]);
    };
    return visit(null);
}

/**
 * Collections in tree order. Link categories are skipped and their children become roots.
 * @param {object} raw Snapshot tables (categories, category_translations).
 * @param {object} ctx { storefront, translated, authored, categorySlugOf }.
 * @param {Map<string, string[]>} offersByCategory category id -> offer source ids.
 * @returns {{ collections: object[], skippedLinks: string[], decisions: Array<{ topic: string, text: string }> }} Never throws.
 */
export function buildCollections(raw, ctx, offersByCategory) {
    const { storefront, translated, authored, categorySlugOf } = ctx;
    const categoryNames = groupBy(raw.category_translations, 'category_id');
    const ordered = orderCategories(raw.categories);
    const skippedLinks = ordered.filter(c => c.type === 'link').map(c => c.id);
    const skipped = new Set(skippedLinks);

    const collections = ordered
        .filter(c => c.type !== 'link')
        .map(c => {
            const own = byLangMap(categoryNames.get(c.id) ?? []);
            const names = authored(translated(own, null, 'name'));
            return {
                sourceId: c.id,
                // A child of a skipped link category would lose its parent; it becomes a root.
                parentSourceId: skipped.has(c.parent_id) ? null : c.parent_id,
                level: c.level,
                names,
                descriptions: authored(translated(own, null, 'description')),
                slugs: Object.fromEntries(Object.keys(names).map(code => [code, categorySlugOf(c.id, code, names[code])])),
                isPrivate: !c.active,
                hiddenInNavigation: !c.visible,
                isStorefrontRoot: c.id === storefront.navigation_category_id,
                assignment: c.product_assignment_type,
                offerSourceIds: c.product_assignment_type === 'product' ? offersByCategory.get(c.id) ?? [] : [],
            };
        });

    return {
        collections,
        skippedLinks,
        decisions: [
            { topic: 'collections', text: 'Each Shopware page or folder category becomes a Collection in the same tree position and sibling order. Membership uses a variant-id filter with inheritFilters=false, so a child category keeps exactly its own assignments instead of being intersected with the parent (Vendure\'s default).' },
            { topic: 'collection visibility', text: 'category.active=false becomes isPrivate. category.visible=false (hidden from navigation) has no Vendure equivalent and is kept only in the model for the storefront to use.' },
        ],
    };
}

/**
 * Offer ids per category, in family and offer order.
 * @param {object[]} families Output of buildFamilies.
 * @param {(offer: object) => string[]} categoriesOf Which categories an offer is listed in.
 * @returns {Map<string, string[]>} Never throws.
 */
export function offersByCategory(families, categoriesOf) {
    const pairs = families.flatMap(f => f.offers.flatMap(o => categoriesOf(o).map(categoryId => [categoryId, o.sourceId])));
    return new Map([...groupBy(pairs, ([categoryId]) => categoryId)].map(([categoryId, list]) => [categoryId, list.map(([, id]) => id)]));
}
