// toMinorUnits decides whether a Shopware price reaches Vendure at all; slugify decides URLs and
// codes. Both are pinned to their current behaviour, including the inputs they do not reject.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { slugify, toMinorUnits } from '../src/lib/util.mjs';

describe('toMinorUnits', () => {
    test('converts decimal strings and numbers to cents', () => {
        assert.deepEqual(toMinorUnits('19.99'), { ok: true, minor: 1999 });
        assert.deepEqual(toMinorUnits('-4.20'), { ok: true, minor: -420 });
        assert.deepEqual(toMinorUnits('1e2'), { ok: true, minor: 10000 });
    });

    test('absorbs binary float noise', () => {
        // 19.99 * 100 is 1998.9999999999998 in IEEE 754.
        assert.deepEqual(toMinorUnits(19.99), { ok: true, minor: 1999 });
    });

    test('rejects sub-cent values instead of rounding them', () => {
        assert.deepEqual(toMinorUnits('12.345'), { ok: false, reason: 'sub-minor-unit precision', value: '12.345' });
        assert.deepEqual(toMinorUnits('1.005'), { ok: false, reason: 'sub-minor-unit precision', value: '1.005' });
    });

    test('honours the decimals argument', () => {
        assert.deepEqual(toMinorUnits('1.234', 3), { ok: true, minor: 1234 });
        assert.deepEqual(toMinorUnits('1.5', 0), { ok: false, reason: 'sub-minor-unit precision', value: '1.5' });
    });

    test('rejects values that are not numbers', () => {
        assert.deepEqual(toMinorUnits('abc'), { ok: false, reason: 'not a number', value: 'abc' });
        assert.deepEqual(toMinorUnits(undefined), { ok: false, reason: 'not a number', value: undefined });
        assert.deepEqual(toMinorUnits(Infinity), { ok: false, reason: 'not a number', value: Infinity });
    });

    test('treats null and empty string as zero, so callers must check for a missing price first', () => {
        // Number(null) and Number('') are 0. Transform checks for a missing price before calling this.
        assert.deepEqual(toMinorUnits(null), { ok: true, minor: 0 });
        assert.deepEqual(toMinorUnits(''), { ok: true, minor: 0 });
    });
});

describe('slugify', () => {
    test('lowercases and joins words with single hyphens', () => {
        assert.equal(slugify(' --Hello, World!-- '), 'hello-world');
        assert.equal(slugify('a__b..c'), 'a-b-c');
    });

    test('strips accents and spells out sharp s', () => {
        assert.equal(slugify('Größe Äpfel'), 'grosse-apfel');
        assert.equal(slugify('Crème brûlée'), 'creme-brulee');
    });

    test('drops characters without an ASCII decomposition', () => {
        assert.equal(slugify('日本'), '');
        assert.equal(slugify('ÆØ ﬁ'), 'fi');
    });

    test('accepts null, undefined and numbers', () => {
        assert.equal(slugify(null), '');
        assert.equal(slugify(undefined), '');
        assert.equal(slugify(123), '123');
    });

    test('keeps an existing slug stable', () => {
        assert.equal(slugify('main-product-with-variants'), 'main-product-with-variants');
    });
});
