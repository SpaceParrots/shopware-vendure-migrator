// toMinorUnits decides whether a Shopware price reaches Vendure at all; slugify decides URLs and
// codes; toCsv writes the redirect list. Each is pinned with the inputs the source data can have.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { slugify, toCsv, toMinorUnits } from '../src/lib/util.mjs';

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
        assert.deepEqual(toMinorUnits(Infinity), { ok: false, reason: 'not a number', value: Infinity });
        assert.deepEqual(toMinorUnits(NaN), { ok: false, reason: 'not a number', value: NaN });
    });

    test('rejects null, undefined and blank strings as missing instead of reading them as zero', () => {
        // Number(null), Number('') and Number(' ') are all 0; a missing price must never become a free product.
        assert.deepEqual(toMinorUnits(null), { ok: false, reason: 'missing', value: null });
        assert.deepEqual(toMinorUnits(undefined), { ok: false, reason: 'missing', value: undefined });
        assert.deepEqual(toMinorUnits(''), { ok: false, reason: 'missing', value: '' });
        assert.deepEqual(toMinorUnits('  '), { ok: false, reason: 'missing', value: '  ' });
    });

    test('rejects input that is neither a string nor a number', () => {
        // Number(true) is 1 and Number([5]) is 5; neither is a price.
        for (const value of [true, false, {}, [5], 5n]) {
            assert.deepEqual(toMinorUnits(value), { ok: false, reason: 'not a string or number', value });
        }
    });

    test('zero is a price, not a missing value', () => {
        assert.deepEqual(toMinorUnits(0), { ok: true, minor: 0 });
        assert.deepEqual(toMinorUnits('0.00'), { ok: true, minor: 0 });
    });

    test('throws on an invalid decimals argument', () => {
        assert.throws(() => toMinorUnits('1', -1), RangeError);
        assert.throws(() => toMinorUnits('1', 1.5), RangeError);
        assert.throws(() => toMinorUnits('1', '2'), RangeError);
    });
});

describe('toCsv', () => {
    test('writes plain fields unquoted and ends every line with CRLF', () => {
        assert.equal(toCsv(['a', 'b'], [['x', 1]]), 'a,b\r\nx,1\r\n');
    });

    test('quotes fields with commas, quotes and line breaks, doubling inner quotes', () => {
        assert.equal(
            toCsv(['v'], [['a,b'], ['say "hi"'], ['line\nbreak'], ['cr\r']]),
            'v\r\n"a,b"\r\n"say ""hi"""\r\n"line\nbreak"\r\n"cr\r"\r\n',
        );
    });

    test('writes null and undefined as empty fields', () => {
        assert.equal(toCsv(['a', 'b', 'c'], [[null, undefined, 0]]), 'a,b,c\r\n,,0\r\n');
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

    test('strips every combining mark, not only the basic diacritics block', () => {
        // U+1DC4 is in Combining Diacritical Marks Supplement, U+20D7 in the marks-for-symbols block.
        assert.equal(slugify('a᷄b⃗'), 'ab');
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
