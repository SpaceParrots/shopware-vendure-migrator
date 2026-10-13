// verify-sales history checks: entries only at times Shopware recorded, and order state entries
// that chain into the order's state.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { historyProblems, stateChainProblems } from '../src/verify-sales.mjs';

const entry = (type, createdAt, from, to) => ({ type, createdAt, data: { from, to } });

describe('historyProblems', () => {
    test('entries at Shopware times and in the expected number pass', () => {
        const items = [entry('ORDER_STATE_TRANSITION', '2026-01-01T10:00:00.000Z'), entry('ORDER_PAYMENT_TRANSITION', '2026-01-02T08:00:00.000Z')];
        assert.deepEqual(historyProblems(items, 2, ['2026-01-01 10:00:00.000', null, '2026-01-02 08:00:00.000']), []);
    });

    test('a missing entry or one at the import time is reported', () => {
        const items = [entry('ORDER_STATE_TRANSITION', '2026-09-27T12:00:00.000Z')];
        const problems = historyProblems(items, 2, ['2026-01-01 10:00:00.000']);
        assert.equal(problems.length, 2);
        assert.match(problems[0], /1 entries, expected 2/);
        assert.match(problems[1], /did not record, e.g. ORDER_STATE_TRANSITION at 2026-09-27T12:00:00.000Z/);
    });
});

describe('stateChainProblems', () => {
    test('a chain ending in the order state passes, payment entries do not break it', () => {
        const items = [
            entry('ORDER_STATE_TRANSITION', 'x', 'AddingItems', 'ArrangingPayment'),
            entry('ORDER_PAYMENT_TRANSITION', 'x', 'Created', 'Settled'),
            entry('ORDER_STATE_TRANSITION', 'x', 'ArrangingPayment', 'PaymentSettled'),
        ];
        assert.deepEqual(stateChainProblems(items, 'PaymentSettled'), []);
    });

    test('a gap in the chain and a wrong end are reported', () => {
        const items = [
            entry('ORDER_STATE_TRANSITION', 'x', 'AddingItems', 'ArrangingPayment'),
            entry('ORDER_STATE_TRANSITION', 'x', 'PaymentSettled', 'Shipped'),
        ];
        assert.deepEqual(stateChainProblems(items, 'Delivered'), [
            'ArrangingPayment is followed by a transition from PaymentSettled',
            'history ends in Shipped, the order is Delivered',
        ]);
        assert.deepEqual(stateChainProblems([], 'Delivered'), ['history ends in nothing, the order is Delivered']);
    });
});
