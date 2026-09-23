// Shopware keeps three state machines per order (order, delivery, transaction); Vendure keeps one
// order state plus a state per payment and per fulfillment. The mapping is a table of rules, and a
// combination no rule covers is refused, not guessed.

/** The order states of Shopware's order.state machine; anything else is refused. */
const ORDER_STATES = new Set(['open', 'in_progress', 'completed', 'cancelled']);

/** Vendure payment state for the state of a Shopware transaction. */
const PAYMENT = {
    paid: 'Settled',
    refunded: 'Settled',
    refunded_partially: 'Settled',
    authorized: 'Authorized',
    // Placed but not paid yet: invoice, prepayment, or a reminder sent. Vendure places an order
    // only on an authorized or settled payment, so these become authorized payments.
    open: 'Authorized',
    reminded: 'Authorized',
    in_progress: 'Authorized',
    unconfirmed: 'Authorized',
    paid_partially: 'Authorized',
    failed: 'Declined',
    cancelled: 'Cancelled',
};

/** Why a payment state is an approximation; shown per order in the model and counted in gaps. */
const PAYMENT_NOTE = {
    open: 'unpaid transaction imported as an authorized payment',
    reminded: 'reminded transaction imported as an authorized payment',
    in_progress: 'transaction in progress imported as an authorized payment',
    unconfirmed: 'unconfirmed transaction imported as an authorized payment',
    paid_partially: 'partly paid: Shopware records no captured amount without capture rows, imported as authorized for the full amount',
    refunded_partially: 'partly refunded: Shopware records no refunded amount without refund rows, no Vendure refund created',
};

/**
 * Maps the three Shopware states of an order to Vendure.
 * @param {{ order: string, delivery?: string, transaction?: string }} s Technical state names;
 *   delivery and transaction are the order's primary (latest) ones.
 * @returns {{ ok: true, orderState: string, paymentState: string|null, refund: 'full'|null,
 *   fulfillmentState: 'Shipped'|'Delivered'|null, notes: string[] } | { ok: false, reason: string }}
 */
export function mapOrderStates({ order, delivery, transaction }) {
    const key = `${order}/${delivery ?? '-'}/${transaction ?? '-'}`;
    if (!ORDER_STATES.has(order)) return { ok: false, reason: `${key}: unknown order state` };
    if (!transaction) return { ok: false, reason: `${key}: order without transaction` };
    if (transaction === 'chargeback') return { ok: false, reason: `${key}: chargebacks have no Vendure payment state` };
    const paymentState = PAYMENT[transaction];
    if (!paymentState) return { ok: false, reason: `${key}: unknown transaction state` };
    const notes = PAYMENT_NOTE[transaction] ? [PAYMENT_NOTE[transaction]] : [];
    const refund = transaction === 'refunded' ? 'full' : null;

    if (order === 'cancelled') {
        if (delivery && !['cancelled', 'open'].includes(delivery)) return { ok: false, reason: `${key}: cancelled order with a delivery in state ${delivery}` };
        return { ok: true, orderState: 'Cancelled', paymentState, refund, fulfillmentState: null, notes };
    }
    if (paymentState === 'Cancelled') return { ok: false, reason: `${key}: open order with a cancelled payment` };

    // Placed orders from here on.
    const placedState = paymentState === 'Settled' ? 'PaymentSettled' : paymentState === 'Authorized' ? 'PaymentAuthorized' : null;
    // Goods left the warehouse only on an authorised or settled payment; a shipped order with a
    // declined payment has no consistent Vendure state.
    if (!placedState && ['shipped', 'shipped_partially', 'returned', 'returned_partially'].includes(delivery)) {
        return { ok: false, reason: `${key}: delivery ${delivery} with a declined payment` };
    }
    switch (delivery) {
        case 'shipped':
            if (order === 'completed') return { ok: true, orderState: 'Delivered', paymentState, refund, fulfillmentState: 'Delivered', notes };
            return { ok: true, orderState: 'Shipped', paymentState, refund, fulfillmentState: 'Shipped', notes };
        case 'shipped_partially':
            // Shopware's partial states are flags: no position says which quantities left.
            return { ok: true, orderState: placedState, paymentState, refund, fulfillmentState: null,
                notes: [...notes, 'partly shipped: Shopware records no shipped quantities, no fulfillment created'] };
        case 'returned':
        case 'returned_partially':
            return { ok: true, orderState: 'Delivered', paymentState, refund, fulfillmentState: 'Delivered',
                notes: [...notes, `delivery ${delivery}: Vendure has no return state, returns need a plugin`] };
        case 'open':
        case undefined:
            if (order === 'completed') return { ok: false, reason: `${key}: completed order without a shipped delivery` };
            if (!placedState) {
                // A failed payment leaves the Shopware order open for a new payment attempt.
                return { ok: true, orderState: 'ArrangingPayment', paymentState, refund, fulfillmentState: null,
                    notes: [...notes, 'payment failed: imported as an inactive order in ArrangingPayment'] };
            }
            return { ok: true, orderState: placedState, paymentState, refund, fulfillmentState: null, notes };
        default:
            return { ok: false, reason: `${key}: delivery state ${delivery} not mapped` };
    }
}
