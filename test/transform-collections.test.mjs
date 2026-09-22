// Category order and tree shape decide where every collection lands in Vendure. Shopware keeps
// sibling order as a linked list, which real data breaks, and link categories have no Vendure form.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCollections, orderCategories } from '../src/transform/collections.mjs';

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
