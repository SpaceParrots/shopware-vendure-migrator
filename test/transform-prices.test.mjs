// resolvePrice turns Shopware's price JSON into the two numbers load chooses from. A wrong pick
// or a silent rounding here changes what customers pay.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { currencyDecimals, resolvePrice } from '../src/transform/prices.mjs';

const CURRENCY = 'eur';
const opts = (pricesIncludeTax = true, decimals = 2) => ({ currencyId: CURRENCY, decimals, pricesIncludeTax });
const json = (gross, net, extra = {}) => JSON.stringify({ [`c${CURRENCY}`]: { gross, net, linked: false, ...extra } });

describe('resolvePrice', () => {
    test('reads gross and net of the default currency from JSON text or a parsed object', () => {
        const fromText = resolvePrice(json('19.99', '16.80'), opts());
        const fromObject = resolvePrice(JSON.parse(json('19.99', '16.80')), opts());
        for (const r of [fromText, fromObject]) {
            assert.equal(r.priceGrossMinor, 1999);
            assert.equal(r.priceNetMinor, 1680);
            assert.equal(r.problem, null);
        }
    });

    test('only the price load sends can be a problem', () => {
        const derivedNet = json(826.77, 694.7647058823529);
        assert.equal(resolvePrice(derivedNet, opts(true)).problem, null);
        assert.deepEqual(resolvePrice(derivedNet, opts(false)).problem, {
            kind: 'subCentPrice', field: 'net', value: 694.7647058823529, reason: 'net price sub-minor-unit precision',
        });
    });

    test('a missing chosen price is unconvertible, not zero', () => {
        const r = resolvePrice(json(null, '5'), opts(true));
        assert.equal(r.priceGrossMinor, null);
        assert.equal(r.priceNetMinor, 500);
        assert.deepEqual(r.problem, { kind: 'unconvertiblePrice', field: 'gross', value: null, reason: 'gross price missing' });
    });

    test('uses the currency decimals', () => {
        assert.equal(resolvePrice(json('1234', '1000'), opts(true, 0)).priceGrossMinor, 1234);
        assert.equal(resolvePrice(json('1.234', '1'), opts(true, 3)).priceGrossMinor, 1234);
        assert.equal(resolvePrice(json('1.5', '1'), opts(true, 0)).problem.kind, 'subCentPrice');
    });

    test('no price, invalid JSON and a price only in other currencies are problems of their own', () => {
        assert.equal(resolvePrice(null, opts()).problem.kind, 'unpriced');
        assert.equal(resolvePrice('{"x"', opts()).problem.kind, 'invalidPriceJson');
        const other = resolvePrice(JSON.stringify({ cusd: { gross: 1, net: 1 } }), opts());
        assert.equal(other.problem.kind, 'nonDefaultCurrencyOnly');
        assert.deepEqual(other.otherCurrencyKeys, ['cusd']);
    });

    test('flags list prices and other currency keys', () => {
        const r = resolvePrice(JSON.stringify({ [`c${CURRENCY}`]: { gross: 1, net: 1, listPrice: { gross: 2, net: 2 } }, cusd: { gross: 1, net: 1 } }), opts());
        assert.equal(r.hasListPrice, true);
        assert.deepEqual(r.otherCurrencyKeys, ['cusd']);
        assert.equal(resolvePrice(json(1, 1, { listPrice: null }), opts()).hasListPrice, false);
    });
});

describe('currencyDecimals', () => {
    test('reads decimals from item_rounding, parsed or as text, string or number', () => {
        assert.deepEqual(currencyDecimals({ item_rounding: { decimals: '2', interval: 0.01 } }), { decimals: 2, source: 'item_rounding' });
        assert.deepEqual(currencyDecimals({ item_rounding: '{"decimals": 0}' }), { decimals: 0, source: 'item_rounding' });
        assert.deepEqual(currencyDecimals({ item_rounding: { decimals: 3 } }), { decimals: 3, source: 'item_rounding' });
    });

    test('falls back to 2 when the value is absent or unusable', () => {
        for (const item_rounding of [undefined, null, '', 'not json', {}, { decimals: '' }, { decimals: -1 }, { decimals: '1.5' }]) {
            assert.deepEqual(currencyDecimals({ item_rounding }), { decimals: 2, source: 'default' }, JSON.stringify(item_rounding));
        }
    });
});
