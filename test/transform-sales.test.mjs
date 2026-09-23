// Customers and orders: who becomes which Vendure customer, which password hashes still log in,
// how three Shopware states become one Vendure state, and where every cent of an order goes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCustomers, normalizeEmail, vendurePasswordHash } from '../src/transform/customers.mjs';
import { mapOrderStates } from '../src/transform/order-states.mjs';
import { buildOrders } from '../src/transform/orders.mjs';

const customer = (id, email, { guest = 0, created = '2026-01-01 00:00:00.000', password = '$2y$10$abc' } = {}) => ({
    id, email, guest, created_at: created, password: guest ? null : password, active: 1, customer_group_id: 'g1',
    sales_channel_id: 'sc1', first_name: 'A', last_name: 'B', has_legacy_password: 0,
});
const customersRaw = rows => ({ customers: rows, customer_addresses: [], customer_groups: [{ id: 'g1', name: 'Standard' }], salutations: [] });

describe('vendurePasswordHash', () => {
    test('rewrites PHP $2y$ to $2b$ and keeps $2a$/$2b$', () => {
        assert.deepEqual(vendurePasswordHash('$2y$10$xyz'), { ok: true, hash: '$2b$10$xyz', rewritten: true });
        assert.deepEqual(vendurePasswordHash('$2b$10$xyz'), { ok: true, hash: '$2b$10$xyz', rewritten: false });
    });

    test('refuses other schemes and missing hashes instead of passing them on', () => {
        assert.equal(vendurePasswordHash('$argon2id$v=19$m=65536').ok, false);
        assert.equal(vendurePasswordHash(null).reason, 'no password');
    });
});

describe('buildCustomers', () => {
    test('a guest with the email of a registered account becomes that account', () => {
        const r = buildCustomers(customersRaw([
            customer('guest', 'Anna@Example.com ', { guest: 1, created: '2025-01-01 00:00:00.000' }),
            customer('reg', 'anna@example.com'),
        ]));
        assert.equal(r.customers.length, 1);
        assert.equal(r.customers[0].sourceId, 'reg');
        assert.equal(r.mergedInto.guest, 'reg');
        assert.equal(r.gaps.guestsMergedIntoRegistered, 1);
    });

    test('guests sharing an email become the oldest guest, without user or addresses', () => {
        const r = buildCustomers(customersRaw([
            customer('g2', 'x@example.com', { guest: 1, created: '2026-02-01 00:00:00.000' }),
            customer('g1', 'x@example.com', { guest: 1, created: '2026-01-01 00:00:00.000' }),
        ]));
        assert.deepEqual(r.customers.map(c => c.sourceId), ['g1']);
        assert.equal(r.customers[0].passwordHash, undefined);
        assert.deepEqual(r.customers[0].addresses, []);
        assert.equal(r.mergedInto.g2, 'g1');
    });

    test('a second registered account on one email is listed, not merged', () => {
        const r = buildCustomers(customersRaw([customer('a', 'same@example.com'), customer('b', 'same@example.com', { created: '2026-03-01 00:00:00.000' })]));
        assert.equal(r.customers.length, 1);
        assert.deepEqual(r.gaps.registeredEmailConflicts, [{ sourceId: 'b', email: 'same@example.com', keptSourceId: 'a' }]);
        assert.equal(r.mergedInto.b, undefined);
    });

    test('registered passwords are carried in the Vendure bcrypt prefix', () => {
        const r = buildCustomers(customersRaw([customer('a', 'a@example.com')]));
        assert.equal(r.customers[0].passwordHash, '$2b$10$abc');
        assert.equal(r.gaps.passwordsRewritten2yTo2b, 1);
    });

    test('normalizeEmail trims and lower-cases', () => {
        assert.equal(normalizeEmail('  Mixed@Case.DE '), 'mixed@case.de');
    });
});

describe('mapOrderStates', () => {
    const cases = [
        [['completed', 'shipped', 'paid'], 'Delivered', 'Settled', 'Delivered'],
        [['in_progress', 'shipped', 'paid'], 'Shipped', 'Settled', 'Shipped'],
        [['open', 'open', 'open'], 'PaymentAuthorized', 'Authorized', null],
        [['open', 'open', 'paid'], 'PaymentSettled', 'Settled', null],
        [['cancelled', 'cancelled', 'refunded'], 'Cancelled', 'Settled', null],
        [['cancelled', 'cancelled', 'cancelled'], 'Cancelled', 'Cancelled', null],
        [['open', 'open', 'failed'], 'ArrangingPayment', 'Declined', null],
        [['in_progress', 'shipped_partially', 'paid'], 'PaymentSettled', 'Settled', null],
        [['in_progress', 'returned', 'paid'], 'Delivered', 'Settled', 'Delivered'],
    ];
    for (const [[order, delivery, transaction], orderState, paymentState, fulfillmentState] of cases) {
        test(`${order}/${delivery}/${transaction} -> ${orderState}`, () => {
            const r = mapOrderStates({ order, delivery, transaction });
            assert.equal(r.ok, true);
            assert.deepEqual([r.orderState, r.paymentState, r.fulfillmentState], [orderState, paymentState, fulfillmentState]);
        });
    }

    test('a full refund is flagged, a partial one only noted', () => {
        assert.equal(mapOrderStates({ order: 'cancelled', delivery: 'cancelled', transaction: 'refunded' }).refund, 'full');
        const partial = mapOrderStates({ order: 'completed', delivery: 'shipped', transaction: 'refunded_partially' });
        assert.equal(partial.refund, null);
        assert.match(partial.notes[0], /no Vendure refund created/);
    });

    test('combinations without a sound mapping are refused', () => {
        assert.equal(mapOrderStates({ order: 'completed', delivery: 'shipped', transaction: 'chargeback' }).ok, false);
        assert.equal(mapOrderStates({ order: 'completed', delivery: 'open', transaction: 'paid' }).ok, false);
        assert.equal(mapOrderStates({ order: 'cancelled', delivery: 'shipped', transaction: 'paid' }).ok, false);
        assert.equal(mapOrderStates({ order: 'open', delivery: 'open' }).ok, false);
        assert.equal(mapOrderStates({ order: 'on_hold', delivery: 'open', transaction: 'paid' }).ok, false);
        for (const delivery of ['shipped', 'shipped_partially', 'returned']) {
            assert.equal(mapOrderStates({ order: 'completed', delivery, transaction: 'failed' }).ok, false, `${delivery} with a failed payment`);
        }
    });
});

describe('buildOrders', () => {
    const money = (unitPrice, quantity, taxes) => ({ unitPrice, totalPrice: unitPrice * quantity, quantity, calculatedTaxes: taxes });
    const raw = lines => ({
        orders: [{
            id: 'o1', order_number: '10000', state: 'open', currency: 'EUR', tax_status: 'gross', amount_total: '0', amount_net: '0',
            price: { calculatedTaxes: [] }, shipping_costs: { totalPrice: 0, calculatedTaxes: [{ taxRate: 19, price: 0, tax: 0 }] },
            item_rounding: { decimals: 2 }, order_date_time: '2026-01-01 10:00:00.000', billing_address_id: 'a1',
        }],
        order_line_items: lines.map((l, i) => ({ id: `l${i}`, order_id: 'o1', parent_id: null, ...l })),
        order_deliveries: [{ id: 'd1', order_id: 'o1', state: 'open', shipping_address_id: 'a1', shipping_method_id: 's1', tracking_codes: '[]' }],
        order_transactions: [{ id: 't1', order_id: 'o1', state: 'paid', payment_method_id: 'p1', amount: { totalPrice: 0 }, created_at: '2026-01-01 10:00:00.000' }],
        order_customers: [{ order_id: 'o1', customer_id: 'guest-2', email: 'x@example.com' }],
        customers: [{ id: 'guest-1' }, { id: 'guest-2' }, { id: 'conflict' }],
        order_addresses: [{ id: 'a1', country_iso: 'DE', first_name: 'A', last_name: 'B', street: 'S 1', city: 'C', zipcode: '1' }],
        payment_methods: [{ id: 'p1', technical_name: 'payment_invoice', name: 'Invoice' }],
        shipping_methods: [{ id: 's1', technical_name: 'standard', name: 'Standard' }],
        order_state_history: [],
    });
    const ctx = { mergedInto: { 'guest-2': 'guest-1' }, offerIds: new Set(['v1']), familyIds: new Set(['parent']) };

    test('a discount spread over two rates becomes one surcharge per rate with its share', () => {
        const r = buildOrders(raw([
            { type: 'product', product_id: 'v1', label: 'P', quantity: 2, price: money(10, 2, [{ taxRate: 19, price: 20, tax: 3.19 }]) },
            { type: 'promotion', label: 'Promo', promotion_code: 'SAVE', quantity: 1, price: { unitPrice: -3, totalPrice: -3, calculatedTaxes: [{ taxRate: 7, price: -1, tax: -0.07 }, { taxRate: 19, price: -2, tax: -0.32 }] } },
        ]), ctx);
        const [o] = r.orders;
        assert.deepEqual(o.surcharges.map(s => [s.taxRate, s.listPrice, s.sku]), [[7, -100, 'SAVE'], [19, -200, 'SAVE']]);
        assert.deepEqual(o.couponCodes, ['SAVE']);
        assert.equal(o.customerSourceId, 'guest-1', 'orders follow the merged customer');
        assert.deepEqual(o.lines.map(l => [l.productSourceId, l.listPrice, l.quantity]), [['v1', 1000, 2]]);
    });

    test('deleted and parent products point at no variant and are counted apart', () => {
        const r = buildOrders(raw([
            { type: 'product', product_id: null, label: 'Gone', quantity: 1, price: money(5, 1, [{ taxRate: 19, price: 5, tax: 0.8 }]) },
            { type: 'product', product_id: 'parent', label: 'Parent', quantity: 1, price: money(5, 1, [{ taxRate: 19, price: 5, tax: 0.8 }]) },
        ]), ctx);
        assert.deepEqual(r.orders[0].lines.map(l => l.productSourceId), [null, null]);
        assert.equal(r.gaps.linesWithDeletedProduct, 1);
        assert.equal(r.gaps.linesOnParentProduct, 1);
    });

    test('shares that miss the line total are kept as stored and counted', () => {
        const r = buildOrders(raw([
            { type: 'promotion', label: 'Promo', quantity: 1, price: { unitPrice: -60.18, totalPrice: -60.18, calculatedTaxes: [{ taxRate: 7, price: -14.45, tax: -0.95 }, { taxRate: 19, price: -45.72, tax: -7.3 }] } },
        ]), ctx);
        assert.deepEqual(r.orders[0].surcharges.map(s => s.listPrice), [-1445, -4572]);
        assert.equal(r.gaps.sharesNotSummingToLineTotal, 1);
    });

    test('an order whose customer was not migrated is refused with the reason, never loaded ownerless', () => {
        const product = { type: 'product', product_id: 'v1', label: 'P', quantity: 1, price: money(1, 1, [{ taxRate: 19, price: 1, tax: 0.16 }]) };
        const refusedWith = customerId => {
            const r = raw([product]);
            r.order_customers[0].customer_id = customerId;
            return buildOrders(r, ctx);
        };
        const conflict = refusedWith('conflict');
        assert.equal(conflict.orders.length, 0);
        assert.match(conflict.refused[0].reason, /registered email conflict/);
        assert.equal(conflict.gaps.ordersOfRefusedCustomers, 1);
        assert.match(refusedWith('deleted').refused[0].reason, /no longer exists/);
    });

    test('unmapped line types, nested lines and multi-rate product lines refuse the order', () => {
        const refusedFor = line => buildOrders(raw([line]), ctx).refused[0]?.reason;
        assert.match(refusedFor({ type: 'container', label: 'Bundle', quantity: 1, price: money(1, 1, []) }), /line type container/);
        assert.match(refusedFor({ type: 'product', parent_id: 'x', product_id: 'v1', label: 'P', quantity: 1, price: money(1, 1, []) }), /nested line/);
        assert.match(refusedFor({ type: 'product', product_id: 'v1', label: 'P', quantity: 1, price: money(1, 1, [{ taxRate: 7 }, { taxRate: 19 }]) }), /2 tax rates/);
    });
});
