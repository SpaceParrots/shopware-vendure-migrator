// Shopware's state history -> Vendure history entries, each at the time Shopware recorded it.
//
// Shopware records every transition of an order's three state machines (order, delivery,
// transaction) in state_machine_history. Vendure keeps one order state, derived here from all
// three by the same table that maps the current states. The replay walks the transitions in time
// order, maps the combination after each one, and writes an entry wherever the Vendure state
// changes. Payments, the refund and the fulfillment get their own entries, as Vendure's own
// processes would write them.
//
// Every time comes from Shopware. Where Shopware records no transition, two kinds of entry are
// synthetic and say so in `data.synthetic`: the placement (Vendure's checkout states, which
// Shopware does not have) and a closing entry where the history stops short of the current state.
import { mapOrderStates, paymentStateOf } from './order-states.mjs';

const T = {
    order: 'ORDER_STATE_TRANSITION',
    payment: 'ORDER_PAYMENT_TRANSITION',
    refund: 'ORDER_REFUND_TRANSITION',
    fulfillment: 'ORDER_FULFILLMENT',
    fulfillmentTransition: 'ORDER_FULFILLMENT_TRANSITION',
};

/** The state a machine started in: before its first recorded transition, or its current state. */
const initialState = (rows, current) => rows[0]?.from_state ?? current;

const shopwareOf = (machine, r) => ({ machine, from: r.from_state, to: r.to_state, action: r.action_name, user: r.username ?? null });

const latest = (...times) => times.filter(Boolean).sort().at(-1);

/**
 * Replays the order's Shopware state machines into Vendure order state entries.
 * @returns {{ entries: object[], unmappedSteps: number, closingEntries: number }}
 */
function replayOrderState({ order, delivery, transactions, finalOrderState }) {
    const state = {
        order: initialState(order.rows, order.state),
        delivery: delivery ? initialState(delivery.rows, delivery.state) : undefined,
        transaction: new Map(transactions.map(t => [t.id, initialState(t.rows, t.state)])),
        current: transactions[0]?.id,
    };
    const events = [
        ...order.rows.map(r => ({ at: r.created_at, apply: () => { state.order = r.to_state; }, shopware: shopwareOf('order', r) })),
        ...(delivery?.rows ?? []).map(r => ({ at: r.created_at, apply: () => { state.delivery = r.to_state; }, shopware: shopwareOf('delivery', r) })),
        ...transactions.flatMap(t => t.rows.map(r => ({ at: r.created_at, apply: () => { state.transaction.set(t.id, r.to_state); }, shopware: shopwareOf('transaction', r) }))),
        // A newer transaction replaces the current one from the moment it is created.
        ...transactions.slice(1).map(t => ({ at: t.createdAt, apply: () => { state.current = t.id; }, shopware: { machine: 'transaction', created: true } })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const entries = [{ type: T.order, at: order.placedAt, isPublic: true, data: { from: 'AddingItems', to: 'ArrangingPayment', synthetic: 'placement' } }];
    let current = 'ArrangingPayment';
    let unmappedSteps = 0;
    const step = (at, shopware, synthetic) => {
        const mapped = mapOrderStates({ order: state.order, delivery: state.delivery, transaction: state.transaction.get(state.current) });
        if (!mapped.ok) { unmappedSteps++; return; }
        if (mapped.orderState === current) return;
        entries.push({ type: T.order, at, isPublic: true, data: { from: current, to: mapped.orderState, ...(synthetic ? { synthetic } : { shopware }) } });
        current = mapped.orderState;
    };
    step(order.placedAt, undefined, 'placement');
    for (const e of events) {
        e.apply();
        step(e.at, e.shopware);
    }
    let closingEntries = 0;
    if (current !== finalOrderState) {
        entries.push({ type: T.order, at: latest(order.placedAt, events.at(-1)?.at), isPublic: true, data: { from: current, to: finalOrderState, synthetic: 'closing' } });
        closingEntries++;
    }
    return { entries, unmappedSteps, closingEntries };
}

/** Payment entries of one transaction; `closeAt` is when a closing entry, if needed, is dated. */
function replayPayment(t, closeAt) {
    const entries = [];
    let current = 'Created';
    let unmappedSteps = 0;
    const to = (next, at, extra) => {
        if (!next) { unmappedSteps++; return; }
        if (next === current) return;
        entries.push({ type: T.payment, at, isPublic: true, paymentSourceId: t.id, data: { from: current, to: next, ...extra } });
        current = next;
    };
    // Created with the transaction, in the state it started in.
    to(paymentStateOf(initialState(t.rows, t.state)), t.createdAt, {});
    for (const r of t.rows) to(paymentStateOf(r.to_state), r.created_at, { shopware: shopwareOf('transaction', r) });
    let closingEntries = 0;
    if (current !== t.paymentState) {
        entries.push({ type: T.payment, at: latest(t.createdAt, t.rows.at(-1)?.created_at, closeAt), isPublic: true, paymentSourceId: t.id, data: { from: current, to: t.paymentState, synthetic: 'closing' } });
        closingEntries++;
    }
    return { entries, unmappedSteps, closingEntries };
}

/**
 * Builds the Vendure history entries of one order. Pure.
 *
 * Times are Shopware's `YYYY-MM-DD HH:MM:SS.mmm` strings (UTC); they sort as text.
 *
 * @param {object} input
 * @param {{ state: string, placedAt: string, rows: object[] }} input.order
 * @param {{ state: string, rows: object[] }} [input.delivery]
 * @param {{ id: string, state: string, paymentState: string, createdAt: string, rows: object[] }[]} input.transactions
 *   In creation order; `paymentState` is the Vendure state the payment is written with.
 * @param {string} input.finalOrderState The Vendure state the order is written with.
 * @param {{ createdAt?: string }} [input.refund]
 * @param {{ state: 'Shipped'|'Delivered', createdAt?: string }} [input.fulfillment]
 *   Rows are state_machine_history rows (`from_state`, `to_state`, `created_at`, `action_name`,
 *   `username`) in time order.
 * @returns {{ entries: object[], unmappedSteps: number, closingEntries: number }} Entries in time
 *   order. A payment entry carries `paymentSourceId`; refund and fulfillment entries leave the id
 *   to the loader.
 */
export function buildOrderHistory({ order, delivery, transactions, finalOrderState, refund, fulfillment }) {
    const orderState = replayOrderState({ order, delivery, transactions, finalOrderState });
    const payments = transactions.map((t, i) => replayPayment(t, transactions[i + 1]?.createdAt ?? orderState.entries.at(-1).at));
    const entries = [...orderState.entries, ...payments.flatMap(p => p.entries)];

    if (refund) {
        entries.push({ type: T.refund, at: refund.createdAt ?? order.placedAt, isPublic: true, data: { from: 'Pending', to: 'Settled', reason: 'Refunded in Shopware' } });
    }
    if (fulfillment) {
        const shippedAt = fulfillment.createdAt ?? order.placedAt;
        entries.push(
            { type: T.fulfillment, at: shippedAt, isPublic: true, data: {} },
            { type: T.fulfillmentTransition, at: shippedAt, isPublic: true, data: { from: 'Created', to: 'Pending' } },
            { type: T.fulfillmentTransition, at: shippedAt, isPublic: true, data: { from: 'Pending', to: 'Shipped' } },
        );
        if (fulfillment.state === 'Delivered') {
            const delivered = orderState.entries.find(e => e.data.to === 'Delivered')?.at;
            entries.push({ type: T.fulfillmentTransition, at: latest(shippedAt, delivered), isPublic: true, data: { from: 'Shipped', to: 'Delivered' } });
        }
    }

    // Stable: entries at the same time keep the order they were written in above.
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const sum = key => orderState[key] + payments.reduce((n, p) => n + p[key], 0);
    return { entries, unmappedSteps: sum('unmappedSteps'), closingEntries: sum('closingEntries') };
}

/**
 * The Vendure history entries of one customer, as Vendure writes them when it registers and
 * verifies a customer with a password. Pure.
 * @param {{ guest: boolean, verified: boolean, createdAt: string, verifiedAt?: string }} customer
 * @returns {{ type: string, at: string, data: object }[]} Nothing for a guest, who has no account.
 */
export function buildCustomerHistory({ guest, verified, createdAt, verifiedAt }) {
    if (guest) return [];
    const entries = [{ type: 'CUSTOMER_REGISTERED', at: createdAt, data: { strategy: 'native' } }];
    if (verified) entries.push({ type: 'CUSTOMER_VERIFIED', at: latest(createdAt, verifiedAt), data: { strategy: 'native' } });
    return entries;
}
