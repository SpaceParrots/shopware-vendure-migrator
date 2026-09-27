// Order history: Shopware's three state machines replayed into Vendure's history entries, each
// at the time Shopware recorded the change.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCustomerHistory, buildOrderHistory } from '../src/transform/order-history.mjs';

const PLACED = '2026-01-01 10:00:00.000';
const row = (from, to, at, extra = {}) => ({ from_state: from, to_state: to, created_at: at, action_name: 'x', username: null, ...extra });
const tx = (id, state, paymentState, rows = [], createdAt = PLACED) => ({ id, state, paymentState, createdAt, rows });
const orderStates = entries => entries.filter(e => e.type === 'ORDER_STATE_TRANSITION').map(e => [e.data.from, e.data.to, e.at]);

describe('buildOrderHistory', () => {
    test('an order without Shopware history gets the placement only', () => {
        const r = buildOrderHistory({
            order: { state: 'open', placedAt: PLACED, rows: [] },
            delivery: { state: 'open', rows: [] },
            transactions: [tx('t1', 'open', 'Authorized')],
            finalOrderState: 'PaymentAuthorized',
        });
        assert.deepEqual(orderStates(r.entries), [
            ['AddingItems', 'ArrangingPayment', PLACED],
            ['ArrangingPayment', 'PaymentAuthorized', PLACED],
        ]);
        assert.deepEqual(r.entries.filter(e => e.type === 'ORDER_PAYMENT_TRANSITION').map(e => [e.paymentSourceId, e.data.from, e.data.to, e.at]), [
            ['t1', 'Created', 'Authorized', PLACED],
        ]);
        assert.equal(r.closingEntries, 0);
    });

    test('each change of the combined Vendure state becomes an entry at the Shopware time', () => {
        const r = buildOrderHistory({
            order: { state: 'completed', placedAt: PLACED, rows: [row('open', 'in_progress', '2026-01-02 09:00:00.000'), row('in_progress', 'completed', '2026-01-05 12:00:00.000')] },
            delivery: { state: 'shipped', rows: [row('open', 'shipped', '2026-01-03 08:00:00.000', { username: 'admin' })] },
            transactions: [tx('t1', 'paid', 'Settled', [row('open', 'paid', '2026-01-02 08:00:00.000')])],
            finalOrderState: 'Delivered',
            fulfillment: { state: 'Delivered', createdAt: '2026-01-03 08:00:00.000' },
        });
        assert.deepEqual(orderStates(r.entries), [
            ['AddingItems', 'ArrangingPayment', PLACED],
            ['ArrangingPayment', 'PaymentAuthorized', PLACED],
            ['PaymentAuthorized', 'PaymentSettled', '2026-01-02 08:00:00.000'],
            ['PaymentSettled', 'Shipped', '2026-01-03 08:00:00.000'],
            ['Shipped', 'Delivered', '2026-01-05 12:00:00.000'],
        ]);
        const shipped = r.entries.find(e => e.data.to === 'Shipped' && e.type === 'ORDER_STATE_TRANSITION');
        assert.deepEqual(shipped.data.shopware, { machine: 'delivery', from: 'open', to: 'shipped', action: 'x', user: 'admin' });
        assert.deepEqual(r.entries.filter(e => e.type.startsWith('ORDER_FULFILLMENT')).map(e => [e.type, e.data.from, e.data.to, e.at]), [
            ['ORDER_FULFILLMENT', undefined, undefined, '2026-01-03 08:00:00.000'],
            ['ORDER_FULFILLMENT_TRANSITION', 'Created', 'Pending', '2026-01-03 08:00:00.000'],
            ['ORDER_FULFILLMENT_TRANSITION', 'Pending', 'Shipped', '2026-01-03 08:00:00.000'],
            ['ORDER_FULFILLMENT_TRANSITION', 'Shipped', 'Delivered', '2026-01-05 12:00:00.000'],
        ]);
        assert.ok(r.entries.every(e => e.type !== 'ORDER_STATE_TRANSITION' || e.isPublic));
    });

    test('entries come out in time order', () => {
        const r = buildOrderHistory({
            order: { state: 'cancelled', placedAt: PLACED, rows: [row('open', 'cancelled', '2026-01-04 00:00:00.000')] },
            delivery: { state: 'cancelled', rows: [row('open', 'cancelled', '2026-01-04 00:00:00.000')] },
            transactions: [tx('t1', 'refunded', 'Settled', [row('open', 'paid', '2026-01-02 00:00:00.000'), row('paid', 'refunded', '2026-01-03 00:00:00.000')])],
            finalOrderState: 'Cancelled',
            refund: { createdAt: '2026-01-03 00:00:00.000' },
        });
        const times = r.entries.map(e => e.at);
        assert.deepEqual(times, [...times].sort());
        assert.deepEqual(r.entries.filter(e => e.type === 'ORDER_REFUND_TRANSITION').map(e => [e.data.from, e.data.to, e.at]), [['Pending', 'Settled', '2026-01-03 00:00:00.000']]);
        assert.deepEqual(orderStates(r.entries).at(-1), ['PaymentSettled', 'Cancelled', '2026-01-04 00:00:00.000']);
    });

    test('a step whose combination the table refuses is skipped and counted', () => {
        // completed/open/paid is refused (completed without a shipped delivery) until the delivery ships.
        const r = buildOrderHistory({
            order: { state: 'completed', placedAt: PLACED, rows: [row('open', 'completed', '2026-01-02 00:00:00.000')] },
            delivery: { state: 'shipped', rows: [row('open', 'shipped', '2026-01-03 00:00:00.000')] },
            transactions: [tx('t1', 'paid', 'Settled', [row('open', 'paid', '2026-01-01 12:00:00.000')])],
            finalOrderState: 'Delivered',
        });
        assert.equal(r.unmappedSteps, 1);
        assert.deepEqual(orderStates(r.entries).at(-1), ['PaymentSettled', 'Delivered', '2026-01-03 00:00:00.000']);
    });

    test('a replaced transaction closes when the next one starts, and the new one drives the order', () => {
        const r = buildOrderHistory({
            order: { state: 'open', placedAt: PLACED, rows: [] },
            delivery: { state: 'open', rows: [] },
            transactions: [
                tx('t1', 'failed', 'Declined', [row('open', 'failed', '2026-01-01 10:05:00.000')]),
                tx('t2', 'paid', 'Settled', [row('open', 'paid', '2026-01-01 11:00:00.000')], '2026-01-01 10:30:00.000'),
            ],
            finalOrderState: 'PaymentSettled',
        });
        assert.deepEqual(orderStates(r.entries).map(([from, to]) => [from, to]), [
            ['AddingItems', 'ArrangingPayment'],
            ['ArrangingPayment', 'PaymentAuthorized'],
            ['PaymentAuthorized', 'ArrangingPayment'],
            ['ArrangingPayment', 'PaymentAuthorized'],
            ['PaymentAuthorized', 'PaymentSettled'],
        ]);
        assert.deepEqual(r.entries.filter(e => e.type === 'ORDER_PAYMENT_TRANSITION').map(e => [e.paymentSourceId, e.data.to, e.at]), [
            ['t1', 'Authorized', PLACED],
            ['t1', 'Declined', '2026-01-01 10:05:00.000'],
            ['t2', 'Authorized', '2026-01-01 10:30:00.000'],
            ['t2', 'Settled', '2026-01-01 11:00:00.000'],
        ]);
    });

    test('an earlier payment that ends in a state its history does not reach is closed at the next transaction', () => {
        const r = buildOrderHistory({
            order: { state: 'open', placedAt: PLACED, rows: [] },
            delivery: { state: 'open', rows: [] },
            transactions: [
                tx('t1', 'open', 'Cancelled'),
                tx('t2', 'paid', 'Settled', [], '2026-01-01 10:30:00.000'),
            ],
            finalOrderState: 'PaymentSettled',
        });
        const t1 = r.entries.filter(e => e.paymentSourceId === 't1').map(e => [e.data.from, e.data.to, e.at, e.data.synthetic]);
        assert.deepEqual(t1, [['Created', 'Authorized', PLACED, undefined], ['Authorized', 'Cancelled', '2026-01-01 10:30:00.000', 'closing']]);
        assert.equal(r.closingEntries, 1);
    });

    test('history that does not reach the current order state is closed at its last known time', () => {
        // The order was cancelled without Shopware's state machine: its history stops at in_progress.
        const r = buildOrderHistory({
            order: { state: 'cancelled', placedAt: PLACED, rows: [row('open', 'in_progress', '2026-01-02 00:00:00.000')] },
            delivery: { state: 'cancelled', rows: [row('open', 'cancelled', '2026-01-03 00:00:00.000')] },
            transactions: [tx('t1', 'cancelled', 'Cancelled', [row('open', 'cancelled', '2026-01-03 00:00:00.000')])],
            finalOrderState: 'Cancelled',
        });
        const last = r.entries.filter(e => e.type === 'ORDER_STATE_TRANSITION').at(-1);
        assert.deepEqual([last.data.from, last.data.to, last.at, last.data.synthetic], ['PaymentAuthorized', 'Cancelled', '2026-01-03 00:00:00.000', 'closing']);
        assert.equal(r.closingEntries, 1, 'the payment history reaches its state, the order history does not');
        assert.equal(r.unmappedSteps, 2);
    });

    test('a machine without history rows has held its current state since placement', () => {
        const r = buildOrderHistory({
            order: { state: 'cancelled', placedAt: PLACED, rows: [] },
            delivery: { state: 'cancelled', rows: [] },
            transactions: [tx('t1', 'cancelled', 'Cancelled')],
            finalOrderState: 'Cancelled',
        });
        assert.deepEqual(orderStates(r.entries).at(-1), ['ArrangingPayment', 'Cancelled', PLACED]);
        assert.equal(r.closingEntries, 0);
    });

    test('an order placed with a failed payment starts in ArrangingPayment', () => {
        const r = buildOrderHistory({
            order: { state: 'open', placedAt: PLACED, rows: [] },
            delivery: { state: 'open', rows: [] },
            transactions: [tx('t1', 'failed', 'Declined')],
            finalOrderState: 'ArrangingPayment',
        });
        assert.deepEqual(orderStates(r.entries), [['AddingItems', 'ArrangingPayment', PLACED]]);
        assert.deepEqual(r.entries.filter(e => e.paymentSourceId).map(e => [e.data.from, e.data.to]), [['Created', 'Declined']]);
    });
});

describe('buildCustomerHistory', () => {
    test('a registered customer is registered at creation and verified at the opt-in confirmation', () => {
        assert.deepEqual(buildCustomerHistory({ guest: false, verified: true, createdAt: PLACED, verifiedAt: '2026-01-02 00:00:00.000' }), [
            { type: 'CUSTOMER_REGISTERED', at: PLACED, data: { strategy: 'native' } },
            { type: 'CUSTOMER_VERIFIED', at: '2026-01-02 00:00:00.000', data: { strategy: 'native' } },
        ]);
    });

    test('an unverified customer is registered only, a guest gets nothing', () => {
        assert.deepEqual(buildCustomerHistory({ guest: false, verified: false, createdAt: PLACED }).map(e => e.type), ['CUSTOMER_REGISTERED']);
        assert.deepEqual(buildCustomerHistory({ guest: true, verified: false, createdAt: PLACED }), []);
    });

    test('a verified customer without a confirmation date is verified at creation', () => {
        assert.equal(buildCustomerHistory({ guest: false, verified: true, createdAt: PLACED }).at(-1).at, PLACED);
    });
});
