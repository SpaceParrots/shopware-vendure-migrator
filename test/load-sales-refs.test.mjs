// load-sales references to customer groups and shipping methods: an unbound one holds back the
// customer or order instead of writing it without the reference, as need() does in load. History
// entries point at the payment, refund or fulfillment written in the same transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customerGroupRefs, historyRefs, requireHistory, shippingMethodRef } from '../src/load-sales.mjs';
import { MissingDependencyError } from '../src/load/context.mjs';

/** Bindings stand-in answering from a flat map keyed `type|sourceId|role`. */
const fakeBindings = entries => ({ get: (type, sourceId, role) => entries[`${type}|${sourceId}|${role}`] });

test('customer groups resolve to their bound ids', () => {
    const bindings = fakeBindings({ 'customerGroup|g1|customerGroup': '7', 'customerGroup|g2|customerGroup': '8' });
    assert.deepEqual(customerGroupRefs(bindings, ['g1', 'g2']), [{ id: '7' }, { id: '8' }]);
});

test('an unbound customer group holds back the customer', () => {
    const bindings = fakeBindings({ 'customerGroup|g1|customerGroup': '7' });
    assert.throws(() => customerGroupRefs(bindings, ['g1', 'g2']), MissingDependencyError);
});

test('an order without a shipping method has none', () => {
    assert.equal(shippingMethodRef(fakeBindings({}), null), null);
});

test('a bound shipping method resolves, an unbound one holds back the order', () => {
    const bindings = fakeBindings({ 'shippingMethod|s1|shippingMethod': '3' });
    assert.equal(shippingMethodRef(bindings, 's1'), '3');
    assert.throws(() => shippingMethodRef(bindings, 's2'), MissingDependencyError);
});

test('history entries point at the ids Vendure puts into their data', () => {
    const saved = { paymentIds: new Map([['t1', 11]]), refund: { id: 21 }, fulfillment: { id: 31 } };
    assert.deepEqual(historyRefs({ type: 'ORDER_PAYMENT_TRANSITION', paymentSourceId: 't1' }, saved), { paymentId: 11 });
    assert.deepEqual(historyRefs({ type: 'ORDER_REFUND_TRANSITION' }, saved), { refundId: 21 });
    assert.deepEqual(historyRefs({ type: 'ORDER_FULFILLMENT' }, saved), { fulfillmentId: 31 });
    assert.deepEqual(historyRefs({ type: 'ORDER_FULFILLMENT_TRANSITION' }, saved), { fulfillmentId: 31 });
    assert.deepEqual(historyRefs({ type: 'ORDER_STATE_TRANSITION' }, saved), {});
});

test('a history entry whose payment, refund or fulfillment the order lacks fails the order', () => {
    const none = { paymentIds: new Map(), refund: undefined, fulfillment: undefined };
    assert.throws(() => historyRefs({ type: 'ORDER_PAYMENT_TRANSITION', paymentSourceId: 't9', at: 'x' }, none), /no payment t9/);
    assert.throws(() => historyRefs({ type: 'ORDER_REFUND_TRANSITION', at: 'x' }, none), /no refund/);
    assert.throws(() => historyRefs({ type: 'ORDER_FULFILLMENT', at: 'x' }, none), /no fulfillment/);
});

test('a sales model written before history existed is refused as a whole, with the fix', () => {
    assert.throws(() => requireHistory({ customers: [{ history: [] }], orders: [{}] }), /run transform-sales again/);
    assert.doesNotThrow(() => requireHistory({ customers: [{ history: [] }], orders: [{ history: [] }] }));
});
