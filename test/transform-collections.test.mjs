// Category order and tree shape decide where every collection lands in Vendure. Shopware keeps
// sibling order as a linked list, which real data breaks, and link categories have no Vendure form.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCollections, categoryIndexGaps, offersByCategory, orderCategories } from '../src/transform/collections.mjs';

const cat = (id, parent_id = null, after_category_id = null, extra = {}) => ({
    id,
    parent_id,
    after_category_id,
    level: parent_id ? 2 : 1,
    active: 1,
    visible: 1,
    type: 'page',
    product_assignment_type: 'product',
    ...extra,
});
const ids = rows => rows.map(r => r.id);

describe('orderCategories', () => {
    test('follows the after_category_id chain, not the row order', () => {
        const rows = [cat('c', null, 'b'), cat('a'), cat('b', null, 'a')];
        assert.deepEqual(ids(orderCategories(rows)), ['a', 'b', 'c']);
    });

    test('visits children depth-first right after their parent', () => {
        const rows = [cat('b', null, 'a'), cat('a2', 'a', 'a1'), cat('a'), cat('a1', 'a'), cat('b1', 'b')];
        assert.deepEqual(ids(orderCategories(rows)), ['a', 'a1', 'a2', 'b', 'b1']);
    });

    test('a broken chain keeps the reachable part in order and appends the rest in id order', () => {
        // 'x' points at a sibling that does not exist and 'm' at 'x', so neither is reachable from the head.
        const rows = [cat('x', null, 'missing'), cat('m', null, 'x'), cat('a'), cat('b', null, 'a')];
        assert.deepEqual(ids(orderCategories(rows)), ['a', 'b', 'm', 'x']);
    });

    test('a cycle does not loop forever and loses no category', () => {
        const rows = [cat('a'), cat('b', null, 'c'), cat('c', null, 'b')];
        assert.deepEqual(ids(orderCategories(rows)), ['a', 'b', 'c']);
    });

    test('does not modify its input', () => {
        const rows = [cat('b', null, 'a'), cat('a')];
        const before = structuredClone(rows);
        orderCategories(rows);
        assert.deepEqual(rows, before);
    });
});

describe('buildCollections', () => {
    const ctx = {
        storefront: { navigation_category_id: 'root' },
        translated: () => ({ en: { value: 'Name', authoredIn: 'en', owner: 'own' } }),
        authored: resolved => Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.value])),
        categorySlugOf: (id, code, name) => `${id}-${code}`,
    };
    const raw = categories => ({ categories, category_translations: [] });

    test('skips link categories and makes their children roots', () => {
        const categories = [cat('root'), cat('link', 'root', null, { type: 'link' }), cat('child', 'link'), cat('page', 'root', 'link')];
        const { collections, skippedLinks } = buildCollections(raw(categories), ctx, new Map());
        assert.deepEqual(skippedLinks, ['link']);
        assert.deepEqual(collections.map(c => [c.sourceId, c.parentSourceId]), [['root', null], ['child', null], ['page', 'root']]);
    });

    test('takes members only for categories with manual assignment', () => {
        const categories = [cat('manual'), cat('stream', null, 'manual', { product_assignment_type: 'product_stream' })];
        const members = new Map([['manual', ['o1']], ['stream', ['o2']]]);
        const { collections } = buildCollections(raw(categories), ctx, members);
        assert.deepEqual(collections.map(c => c.offerSourceIds), [['o1'], []]);
    });
});

describe('membership from the listing index', () => {
    // root > food > fruit. o1 is assigned to fruit and indexed (fruit, food, root); o2 is assigned
    // to food but the index has no rows for it, as after an import without the indexer.
    const categories = [cat('root'), cat('food', 'root'), cat('fruit', 'food')];
    const offer = (sourceId, effectiveCategoryIds, listingCategoryIds) => ({ sourceId, effectiveCategoryIds, listingCategoryIds });
    const families = [{ offers: [offer('o1', ['fruit'], ['fruit', 'food', 'root']), offer('o2', ['food'], [])] }];

    test('an offer is a member of every category its index rows name, ancestors included', () => {
        const members = offersByCategory(families, o => o.listingCategoryIds);
        assert.deepEqual([...members], [['fruit', ['o1']], ['food', ['o1']], ['root', ['o1']]]);
    });

    test('categoryIndexGaps counts assigned offers the index misses and the memberships they would add', () => {
        const members = offersByCategory(families, o => o.listingCategoryIds);
        const { collections } = buildCollections({ categories, category_translations: [] }, {
            storefront: {}, translated: () => ({}), authored: () => ({}), categorySlugOf: () => '',
        }, members);
        const gaps = categoryIndexGaps(categories, families, collections);
        assert.equal(gaps.offersAssignedButNotIndexed, 1);
        assert.equal(gaps.membershipsFromIndex, 3);
        assert.equal(gaps.membershipsIfIndexed, 5);
        assert.equal(gaps.collectionsLosingMembers, 2);
        assert.match(gaps.verdict, /^1 offers have category assignments but no product_category_tree rows/);
    });

    test('categoryIndexGaps flags an index that has the direct categories but not their ancestors', () => {
        // After dal:refresh:index over stale category paths: o1 is indexed on fruit only.
        const stale = [{ offers: [offer('o1', ['fruit'], ['fruit'])] }];
        const members = offersByCategory(stale, o => o.listingCategoryIds);
        const { collections } = buildCollections({ categories, category_translations: [] }, {
            storefront: {}, translated: () => ({}), authored: () => ({}), categorySlugOf: () => '',
        }, members);
        const gaps = categoryIndexGaps(categories, stale, collections);
        assert.equal(gaps.offersAssignedButNotIndexed, 0);
        assert.equal(gaps.membershipsFromIndex, 1);
        assert.equal(gaps.membershipsIfIndexed, 3);
        assert.equal(gaps.collectionsLosingMembers, 2);
        assert.match(gaps.verdict, /^2 collections have fewer members .* \(1 of 3 memberships\): product_category_tree lacks ancestor rows/);
        assert.match(gaps.verdict, /dal:refresh:index/);
    });

    test('categoryIndexGaps reports a complete index as complete', () => {
        const complete = [{ offers: [offer('o1', ['fruit'], ['fruit', 'food', 'root'])] }];
        const members = offersByCategory(complete, o => o.listingCategoryIds);
        const { collections } = buildCollections({ categories, category_translations: [] }, {
            storefront: {}, translated: () => ({}), authored: () => ({}), categorySlugOf: () => '',
        }, members);
        const gaps = categoryIndexGaps(categories, complete, collections);
        assert.equal(gaps.collectionsLosingMembers, 0);
        assert.equal(gaps.verdict, 'the listing index covers every assigned offer and its ancestor categories');
    });
});
