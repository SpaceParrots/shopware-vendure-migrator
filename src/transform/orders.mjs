// Shopware orders -> Vendure orders as historical records.
//
// An imported order must show what the customer was charged, not what today's catalogue would
// charge. Every amount therefore comes from the order's own price JSON, never from a product.
//
// Line types: `product` lines become order lines (a deleted product points at one archived
// placeholder variant). `promotion`, `credit` and `custom` lines have no variant, so they become
// surcharges: one per tax rate of the line, with that rate's share, because a Vendure surcharge has
// one tax rate and Shopware spreads a discount over the rates of the cart.
import { groupBy, toMinorUnits } from '../lib/util.mjs';
import { mapOrderStates } from './order-states.mjs';

const SURCHARGE_TYPES = new Set(['promotion', 'credit', 'custom']);

const parse = json => (typeof json === 'string' ? JSON.parse(json) : json);

const orderAddress = a => (a ? {
    fullName: [a.first_name, a.last_name].filter(Boolean).join(' '),
    company: a.company || undefined,
    streetLine1: a.street,
    streetLine2: [a.additional_address_line1, a.additional_address_line2].filter(Boolean).join(', ') || undefined,
    city: a.city,
    province: a.state_name ?? undefined,
    postalCode: a.zipcode ?? undefined,
    country: a.country_name ?? a.country_iso,
    countryCode: a.country_iso,
    phoneNumber: a.phone_number || undefined,
} : {});

/**
 * Builds the orders of the model. Pure.
 * @param {object} raw Snapshot tables.
 * @param {{ mergedInto: Record<string, string>, offerIds: Set<string>, familyIds?: Set<string> }} ctx
 *   `mergedInto` from buildCustomers; `offerIds` the Shopware product ids that became Vendure
 *   variants; `familyIds` the parent products, which became Vendure products but no variant.
 * @returns {{ orders: object[], refused: object[], decisions: object[], gaps: object, expected: object }}
 */
export function buildOrders(raw, { mergedInto, offerIds, familyIds = new Set() }) {
    const linesByOrder = groupBy(raw.order_line_items, 'order_id');
    const deliveriesByOrder = groupBy(raw.order_deliveries, 'order_id');
    const transactionsByOrder = groupBy(raw.order_transactions, 'order_id');
    const customerByOrder = new Map(raw.order_customers.map(c => [c.order_id, c]));
    const customerIds = new Set(raw.customers.map(c => c.id));
    const addresses = new Map(raw.order_addresses.map(a => [a.id, a]));
    const payments = new Map(raw.payment_methods.map(p => [p.id, p]));
    const shippings = new Map(raw.shipping_methods.map(s => [s.id, s]));
    // Latest time each entity reached each state.
    const reached = new Map();
    for (const h of raw.order_state_history) reached.set(`${h.referenced_id}|${h.to_state}`, h.created_at);

    const orders = [];
    const refused = [];
    const gaps = {
        stateCombinations: {},
        approximations: {},
        lineTypes: {},
        linesWithDeletedProduct: 0,
        // Shopware lets a cart hold a parent product itself; the catalogue slice makes parents
        // product containers only, so such a line has no variant to point at.
        linesOnParentProduct: 0,
        linesWithProductNotMigrated: 0,
        nestedLines: 0,
        surchargesFromLines: 0,
        sharesNotSummingToLineTotal: 0,
        ordersWithoutCustomerRow: 0,
        ordersOfRefusedCustomers: 0,
    };

    const lookups = { linesByOrder, deliveriesByOrder, transactionsByOrder, customerByOrder, customerIds, addresses, payments, shippings, reached, mergedInto, offerIds, familyIds };
    for (const o of raw.orders) {
        const result = buildOrder(o, lookups, gaps);
        if (result.ok) orders.push(result.order);
        else refused.push({ sourceId: o.id, code: o.order_number, reason: result.reason });
    }

    const decisions = [
        {
            topic: 'orders.writePath',
            decision: 'Orders are written in-process through the ORM as finished records, with the amounts, dates, order number and states Shopware holds.',
            why: "Vendure's Admin API has no order import: draft orders reprice every line with today's price and tax, set orderPlacedAt to the import time, generate a new order code, and allocate stock on placement.",
        },
        {
            topic: 'orders.states',
            decision: 'The order, delivery and transaction states are mapped by an explicit table (src/transform/order-states.mjs). A combination the table does not cover refuses the order. The original triple is kept in the order custom field shopwareStates.',
            why: 'Shopware has 4 x 6 x 12 state combinations; a guessed mapping would put orders into states whose meaning differs.',
        },
        {
            topic: 'orders.nonProductLines',
            decision: 'Promotion, credit and custom lines become surcharges, one per tax rate of the line, with the tax share Shopware calculated. Promotion codes go to couponCodes; no Vendure promotion is linked.',
            why: 'Vendure order lines need a product variant; a surcharge has exactly one tax rate, and Shopware spreads a discount across the rates in the cart.',
        },
        {
            topic: 'orders.customer',
            decision: 'An order whose customer did not become a Vendure customer is refused with its reason: the customer row is gone, or it is a second registered account on an email another account kept (registeredEmailConflicts).',
            why: 'A Vendure order needs a customer, and the only customer the channel can hold under that email is a different account; attaching the order there would show it in a stranger\'s history.',
        },
        {
            topic: 'orders.totals',
            decision: "Line, surcharge and shipping amounts are Shopware's. The order's stored totals are Vendure's own calculation from them, except where that differs from Shopware's invoice total by at most one minor unit per surcharge; then the invoice total is stored and the order counted in load-sales-result.json. A larger difference fails the order. A discount line whose shares miss its total by more than one minor unit per share is refused in transform.",
            why: "Shopware computes a discount share's tax from the unrounded share; Vendure computes it from the rounded amount and the rate. Both round per line total and half away from zero (with a PHP-style MoneyStrategy), so the difference is a cent on a few orders. The order total must equal the settled payment, or Vendure sees an outstanding cent on the first modification or refund.",
        },
        {
            topic: 'orders.deletedProducts',
            decision: 'A product line without a Vendure variant points at one disabled placeholder variant, "Archived Shopware product". That covers a deleted product and a parent product, which Shopware can sell itself while the catalogue makes parents containers only. The Shopware label and product number are kept in order line custom fields.',
            why: 'OrderLine.productVariant is required in Vendure; Shopware keeps a deleted product\'s line with product_id NULL.',
        },
        {
            topic: 'orders.sideEffects',
            decision: 'No stock movements, allocations, sales, history entries or events are created for imported orders.',
            why: "Shopware's current stock is already migrated with the catalogue; replaying orders would count every sale twice and could send mails.",
        },
    ];
    const expected = {
        orders: orders.length,
        orderLines: orders.reduce((n, o) => n + o.lines.length, 0),
        surcharges: orders.reduce((n, o) => n + o.surcharges.length, 0),
        payments: orders.reduce((n, o) => n + o.payments.length, 0),
        refunds: orders.filter(o => o.refund).length,
        fulfillments: orders.filter(o => o.fulfillment).length,
        placeholderLines: orders.reduce((n, o) => n + o.lines.filter(l => !l.productSourceId).length, 0),
    };
    return { orders, refused, decisions, gaps, expected };
}

/** An expected reason not to migrate an order. Only buildOrder throws it, and only buildOrder catches it. */
class Refusal extends Error {}

/**
 * Maps one Shopware order. Counts what it sees into `gaps` (buildOrders' own accumulator).
 * @returns {{ ok: true, order: object } | { ok: false, reason: string }} Expected refusals are
 *   data; anything else (a programming error, a malformed row) propagates.
 */
function buildOrder(o, lookups, gaps) {
    try {
        return { ok: true, order: mapOrder(o, lookups, gaps) };
    } catch (e) {
        if (e instanceof Refusal) return { ok: false, reason: e.message };
        throw e;
    }
}

function mapOrder(o, { linesByOrder, deliveriesByOrder, transactionsByOrder, customerByOrder, customerIds, addresses, payments, shippings, reached, mergedInto, offerIds, familyIds }, gaps) {
    const decimals = parse(o.item_rounding)?.decimals ?? 2;
    const money = (amount, what) => {
        const m = toMinorUnits(amount, decimals);
        if (!m.ok) throw new Refusal(`${what}: ${m.reason} (${m.value})`);
        return m.minor;
    };
    if (!['gross', 'net'].includes(o.tax_status)) throw new Refusal(`tax status ${o.tax_status} (tax-free orders are not mapped)`);
    const gross = o.tax_status === 'gross';

    const deliveries = deliveriesByOrder.get(o.id) ?? [];
    const transactions = transactionsByOrder.get(o.id) ?? [];
    const delivery = deliveries[0];
    const lastTransaction = transactions[transactions.length - 1];
    const states = { order: o.state, delivery: delivery?.state, transaction: lastTransaction?.state };
    const stateKey = `${states.order}/${states.delivery ?? '-'}/${states.transaction ?? '-'}`;
    gaps.stateCombinations[stateKey] = (gaps.stateCombinations[stateKey] ?? 0) + 1;
    if (deliveries.length > 1) throw new Refusal('more than one delivery');
    // An earlier paid transaction next to the current one would read as a second settled payment.
    if (transactions.slice(0, -1).some(t => t.state === 'paid')) throw new Refusal('an earlier transaction is paid as well');
    const mapped = mapOrderStates(states);
    if (!mapped.ok) throw new Refusal(mapped.reason);
    for (const n of mapped.notes) gaps.approximations[n] = (gaps.approximations[n] ?? 0) + 1;

    // An order whose customer did not become a Vendure customer is refused: the only one a
    // channel could hold under that email is a different account (registeredEmailConflicts).
    const oc = customerByOrder.get(o.id);
    const customerSourceId = oc?.customer_id ? mergedInto[oc.customer_id] : undefined;
    if (!customerSourceId) {
        if (!oc?.customer_id || !customerIds.has(oc.customer_id)) {
            gaps.ordersWithoutCustomerRow++;
            throw new Refusal(`customer ${oc?.customer_id ?? '(none)'} of the order no longer exists`);
        }
        gaps.ordersOfRefusedCustomers++;
        throw new Refusal(`customer ${oc.customer_id} was not migrated (registered email conflict)`);
    }

    const lines = [];
    const surcharges = [];
    const promotionCodes = new Set();
    for (const li of linesByOrder.get(o.id) ?? []) {
        gaps.lineTypes[li.type] = (gaps.lineTypes[li.type] ?? 0) + 1;
        if (li.parent_id) { gaps.nestedLines++; throw new Refusal(`nested line ${li.id} (${li.type})`); }
        const price = parse(li.price);
        const taxes = price.calculatedTaxes ?? [];
        if (li.type === 'product') {
            if (taxes.length !== 1) throw new Refusal(`product line ${li.id} with ${taxes.length} tax rates`);
            const deleted = !li.product_id;
            if (deleted) gaps.linesWithDeletedProduct++;
            else if (!offerIds.has(li.product_id)) {
                if (familyIds.has(li.product_id)) gaps.linesOnParentProduct++;
                else gaps.linesWithProductNotMigrated++;
            }
            lines.push({
                sourceId: li.id,
                productSourceId: deleted || !offerIds.has(li.product_id) ? null : li.product_id,
                label: li.label,
                productNumber: li.product_number ?? undefined,
                quantity: Number(li.quantity),
                listPrice: money(price.unitPrice, `unit price of line ${li.id}`),
                listPriceIncludesTax: gross,
                taxRate: Number(taxes[0].taxRate),
                // Shopware's own line figures, for the compare stage.
                source: { total: money(price.totalPrice, 'line total'), tax: money(taxes[0].tax, 'line tax') },
            });
        } else if (SURCHARGE_TYPES.has(li.type)) {
            if (li.promotion_code) promotionCodes.add(li.promotion_code);
            // One surcharge per rate. Zero shares are dropped: they carry no money.
            const shares = taxes.filter(t => Number(t.price) !== 0).map(t => ({ rate: Number(t.taxRate), minor: money(t.price, `share of line ${li.id}`) }));
            // Shopware rounds each share on its own and computes its tax from the unrounded
            // share, so the shares can miss the line total by a cent. They are kept as stored;
            // load-sales stores the invoice total within a tolerance of one cent per share.
            const shareGap = money(price.totalPrice, `total of line ${li.id}`) - shares.reduce((n, s) => n + s.minor, 0);
            if (Math.abs(shareGap) > shares.length) throw new Refusal(`shares of line ${li.id} miss its total by ${shareGap}`);
            if (shareGap !== 0) gaps.sharesNotSummingToLineTotal++;
            for (const s of shares) {
                surcharges.push({
                    sourceId: `${li.id}|${s.rate}`,
                    description: taxes.length > 1 ? `${li.label} (${s.rate}% share)` : li.label,
                    sku: li.promotion_code ?? li.type,
                    shopwareLineType: li.type,
                    listPrice: s.minor,
                    listPriceIncludesTax: gross,
                    taxRate: s.rate,
                });
                gaps.surchargesFromLines++;
            }
        } else {
            throw new Refusal(`line type ${li.type} has no mapping`);
        }
    }

    const shippingCosts = parse(o.shipping_costs);
    const shippingTaxes = (shippingCosts.calculatedTaxes ?? []).filter(t => Number(t.price) !== 0);
    if (shippingTaxes.length > 1) throw new Refusal('shipping costs over several tax rates');
    const shippingMethod = delivery ? shippings.get(delivery.shipping_method_id) : undefined;
    const orderPrice = parse(o.price);

    const trackingCodes = delivery?.tracking_codes ? parse(delivery.tracking_codes) : [];
    const payment = t => {
        const method = payments.get(t.payment_method_id);
        const amount = parse(t.amount);
        return {
            sourceId: t.id,
            method: method?.technical_name ?? t.payment_method_id,
            methodName: method?.name,
            amount: money(amount.totalPrice, `transaction ${t.id}`),
            shopwareState: t.state,
            createdAt: reached.get(`${t.id}|${t.state}`) ?? t.created_at,
        };
    };
    const earlierPayments = transactions.slice(0, -1).map(t => ({
        ...payment(t),
        state: { failed: 'Declined', cancelled: 'Cancelled' }[t.state] ?? 'Cancelled',
    }));
    const lastPayment = { ...payment(lastTransaction), state: mapped.paymentState };

    return {
        sourceId: o.id,
        code: o.order_number,
        customerSourceId,
        state: mapped.orderState,
        shopwareStates: stateKey,
        notes: mapped.notes,
        orderPlacedAt: o.order_date_time,
        currencyCode: o.currency,
        pricesIncludeTax: gross,
        couponCodes: [...promotionCodes],
        billingAddress: orderAddress(addresses.get(o.billing_address_id)),
        shippingAddress: orderAddress(addresses.get(delivery?.shipping_address_id)),
        lines,
        surcharges,
        shipping: {
            methodSourceId: delivery?.shipping_method_id,
            methodName: shippingMethod?.name ?? 'Shopware shipping',
            listPrice: money(shippingCosts.totalPrice, 'shipping'),
            listPriceIncludesTax: gross,
            taxRate: Number(shippingTaxes[0]?.taxRate ?? shippingCosts.calculatedTaxes?.[0]?.taxRate ?? 0),
        },
        payments: [...earlierPayments, lastPayment],
        refund: mapped.refund === 'full' ? { amount: lastPayment.amount, createdAt: reached.get(`${lastTransaction.id}|refunded`) } : null,
        fulfillment: mapped.fulfillmentState ? {
            state: mapped.fulfillmentState,
            method: shippingMethod?.name ?? 'Shopware shipping',
            trackingCode: trackingCodes.join(', '),
            createdAt: reached.get(`${delivery.id}|shipped`) ?? reached.get(`${delivery.id}|${delivery.state}`),
        } : null,
        // What Shopware charged, for the compare stage and load-sales' invoice tolerance.
        source: {
            totalWithTax: money(o.amount_total, 'amount_total'),
            total: money(o.amount_net, 'amount_net'),
            taxCalculationType: o.tax_calculation_type,
            taxes: (orderPrice.calculatedTaxes ?? []).map(t => ({ rate: Number(t.taxRate), tax: money(t.tax, 'order tax') })),
        },
    };
}
