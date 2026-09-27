// load-sales references to customer groups and shipping methods: an unbound one holds back the
// customer or order instead of writing it without the reference, as need() does in load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customerGroupRefs, shippingMethodRef } from '../src/load-sales.mjs';
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
