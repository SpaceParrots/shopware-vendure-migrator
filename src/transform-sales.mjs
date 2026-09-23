// Customers and orders: resolves identities and maps each order to a finished Vendure record.
// Runs after transform, on the same snapshot, because order lines point at the catalogue model.
import path from 'node:path';
import { readSnapshot } from './lib/snapshot.mjs';
import { log, readJson, writeJson } from './lib/util.mjs';
import { buildCustomers } from './transform/customers.mjs';
import { buildOrders } from './transform/orders.mjs';

export const SALES_RAW_FILES = [
    'customer_groups', 'salutations', 'customers', 'customer_addresses', 'payment_methods', 'shipping_methods',
    'orders', 'order_customers', 'order_addresses', 'order_line_items', 'order_deliveries',
    'order_delivery_positions', 'order_transactions', 'order_state_history', 'sales_counts',
];

/**
 * Builds the sales model from raw tables and the catalogue model. Pure.
 * @param {object} raw Snapshot tables.
 * @param {object} catalogue model.json of the same snapshot.
 * @returns {{ model: object, decisions: object[], gaps: object }}
 */
export function buildSalesModel(raw, catalogue) {
    const offerIds = new Set(catalogue.families.flatMap(f => f.offers.map(o => o.sourceId)));
    const customers = buildCustomers(raw);
    const familyIds = new Set(catalogue.families.filter(f => f.kind === 'family').map(f => f.sourceId));
    const orders = buildOrders(raw, { mergedInto: customers.mergedInto, offerIds, familyIds });
    const counts = raw.sales_counts[0] ?? {};
    const model = {
        generatedAt: new Date().toISOString(),
        customerGroups: customers.customerGroups,
        customers: customers.customers,
        mergedInto: customers.mergedInto,
        orders: orders.orders,
        shippingMethods: raw.shipping_methods.map(s => ({ sourceId: s.id, code: s.technical_name ?? s.id, name: s.name ?? s.technical_name })),
        expected: {
            customerGroups: customers.customerGroups.length,
            customers: customers.customers.length,
            registeredCustomers: customers.customers.filter(c => !c.guest).length,
            guestCustomers: customers.customers.filter(c => c.guest).length,
            addresses: customers.customers.reduce((n, c) => n + c.addresses.length, 0),
            ...orders.expected,
            ordersRefused: orders.refused.length,
        },
    };
    const gaps = {
        customers: customers.gaps,
        orders: { ...orders.gaps, refused: orders.refused },
        notCarried: {
            documents: Number(counts.documents ?? 0),
            transactionCaptures: Number(counts.captures ?? 0),
            captureRefunds: Number(counts.capture_refunds ?? 0),
            wishlists: Number(counts.wishlists ?? 0),
            newsletterRecipients: Number(counts.newsletter_recipients ?? 0),
            customerTags: Number(counts.customer_tags ?? 0),
            orderTags: Number(counts.order_tags ?? 0),
            productReviews: Number(counts.product_reviews ?? 0),
        },
    };
    return { model, decisions: [...customers.decisions, ...orders.decisions], gaps };
}

export async function transformSales(config, snapshotDir) {
    const { manifest, raw } = await readSnapshot(snapshotDir);
    const missing = SALES_RAW_FILES.filter(f => !manifest.files[f]);
    if (missing.length) throw new Error(`Snapshot ${path.basename(snapshotDir)} has no ${missing.join(', ')}; extract again with this migrator version.`);
    const catalogue = await readJson(path.join(snapshotDir, 'model.json')).catch(() => {
        throw new Error('model.json is missing: run transform on this snapshot first.');
    });
    const { model, decisions, gaps } = buildSalesModel(raw, catalogue);
    await writeJson(path.join(snapshotDir, 'sales-model.json'), model);
    await writeJson(path.join(snapshotDir, 'sales-decisions.json'), decisions);
    await writeJson(path.join(snapshotDir, 'sales-gaps.json'), gaps);
    const e = model.expected;
    log(`transform-sales: ${e.customers} customers (${e.registeredCustomers} registered, ${e.guestCustomers} guest), ${e.addresses} addresses, ${e.customerGroups} groups`);
    log(`transform-sales: ${e.orders} orders, ${e.orderLines} lines, ${e.surcharges} surcharges, ${e.payments} payments, ${e.refunds} refunds, ${e.fulfillments} fulfillments, ${e.placeholderLines} placeholder lines, ${e.ordersRefused} refused`);
    log(`transform-sales: state combinations ${JSON.stringify(gaps.orders.stateCombinations)}`);
    return model;
}
