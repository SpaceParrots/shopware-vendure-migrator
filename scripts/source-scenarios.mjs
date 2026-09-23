// Gives a Shopware demo shop the order history a real shop has, so the customer and order
// migration has something to prove. framework:demodata creates every order as open/open/open with
// only product and promotion lines; this script moves them through Shopware's own state machines,
// places guest orders through the Store API, creates admin orders with custom and credit lines,
// and deletes a few ordered products.
//
// It WRITES to the shop. Run it once, against a throwaway demo shop only, before extract.
//
// Env: SOURCE_MEDIA_BASE_URL (shop URL), SOURCE_ADMIN_USER, SOURCE_ADMIN_PASSWORD,
//      SOURCE_STORE_ACCESS_KEY (storefront sales channel).
// Usage: node --env-file=.env scripts/source-scenarios.mjs
const base = (process.env.SOURCE_MEDIA_BASE_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
const accessKey = process.env.SOURCE_STORE_ACCESS_KEY;

let adminToken;
async function admin(method, path, body) {
    const res = await fetch(`${base}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
}

async function store(method, path, body, contextToken) {
    const res = await fetch(`${base}/store-api${path}`, {
        method,
        headers: {
            'sw-access-key': accessKey,
            'content-type': 'application/json',
            accept: 'application/json',
            ...(contextToken ? { 'sw-context-token': contextToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
    return { data: text ? JSON.parse(text) : null, token: res.headers.get('sw-context-token') ?? contextToken };
}

// Transition names per state machine, applied in order. Each scenario is a combination a real shop
// produces through its admin or payment provider.
const SCENARIOS = {
    open: [],
    paid: [['order_transaction', 'paid']],
    paidInProgress: [['order_transaction', 'paid'], ['order', 'process']],
    shipped: [['order_transaction', 'paid'], ['order', 'process'], ['order_delivery', 'ship']],
    completed: [['order_transaction', 'paid'], ['order', 'process'], ['order_delivery', 'ship'], ['order', 'complete']],
    shippedPartially: [['order_transaction', 'paid'], ['order', 'process'], ['order_delivery', 'ship_partially']],
    cancelledUnpaid: [['order_transaction', 'cancel'], ['order_delivery', 'cancel'], ['order', 'cancel']],
    refunded: [['order_transaction', 'paid'], ['order_transaction', 'refund'], ['order_delivery', 'cancel'], ['order', 'cancel']],
    completedRefundedPartially: [['order_transaction', 'paid'], ['order', 'process'], ['order_delivery', 'ship'], ['order', 'complete'], ['order_transaction', 'refund_partially']],
    paidPartially: [['order_transaction', 'paid_partially']],
    authorized: [['order_transaction', 'authorize']],
    failed: [['order_transaction', 'fail']],
    returned: [['order_transaction', 'paid'], ['order', 'process'], ['order_delivery', 'ship'], ['order_delivery', 'retour']],
    reminded: [['order_transaction', 'remind']],
};
// Weighted cycle: most orders in a real shop are completed.
const CYCLE = [
    'completed', 'completed', 'completed', 'completed', 'completed', 'open', 'open', 'paid', 'paidInProgress', 'shipped',
    'shipped', 'cancelledUnpaid', 'refunded', 'completedRefundedPartially', 'shippedPartially', 'paidPartially',
    'authorized', 'failed', 'returned', 'reminded',
];

async function transitionOrder(order, scenario) {
    for (const [entity, action] of SCENARIOS[scenario]) {
        const id = entity === 'order' ? order.id
            : entity === 'order_transaction' ? order.transactions[order.transactions.length - 1].id
            : order.deliveries[0].id;
        await admin('POST', `/_action/${entity}/${id}/state/${action}`, {});
    }
}

async function guestOrder({ email, firstName, lastName, productId, countryId, salutationId }) {
    const ctx = await store('GET', '/context');
    let token = ctx.token;
    const reg = await store('POST', '/account/register', {
        guest: true, email, firstName, lastName, salutationId, acceptedDataProtection: true,
        storefrontUrl: base,
        billingAddress: { street: 'Musterstraße 1', zipcode: '48143', city: 'Münster', countryId },
    }, token);
    token = reg.token;
    await store('POST', '/checkout/cart/line-item', { items: [{ type: 'product', referencedId: productId, quantity: 2 }] }, token);
    const order = await store('POST', '/checkout/order', {}, token);
    return order.data.orderNumber;
}

// An admin order with a custom line and a credit line, the way the Administration creates one:
// a proxy cart in the storefront channel, then the proxy-order endpoint.
async function adminOrderWithCustomLines({ salesChannelId, customerId, productId }) {
    const ctx = await admin('PATCH', `/_proxy/switch-customer`, { salesChannelId, customerId });
    const token = ctx['sw-context-token'];
    const proxy = async (method, path, body) => {
        const res = await fetch(`${base}/api/_proxy/store-api/${salesChannelId}${path}`, {
            method,
            headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', accept: 'application/json', 'sw-context-token': token },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`proxy ${method} ${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
        return JSON.parse(text);
    };
    await proxy('POST', '/checkout/cart/line-item', { items: [{ type: 'product', referencedId: productId, quantity: 1 }] });
    await proxy('POST', '/checkout/cart/line-item', {
        items: [{
            id: crypto.randomUUID().replace(/-/g, ''), type: 'custom', label: 'Gift wrapping (custom line)', quantity: 1,
            priceDefinition: { type: 'quantity', price: 4.99, quantity: 1, taxRules: [{ taxRate: 19, percentage: 100 }] },
        }],
    });
    const credit = await fetch(`${base}/api/_proxy/store-api/${salesChannelId}/checkout/cart/line-item`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'sw-context-token': token },
        body: JSON.stringify({
            items: [{
                id: crypto.randomUUID().replace(/-/g, ''), type: 'credit', label: 'Goodwill credit (credit line)', quantity: 1,
                priceDefinition: { type: 'absolute', price: -5 },
            }],
        }),
    });
    const creditNote = credit.ok ? 'credit line added' : `credit line refused: HTTP ${credit.status} ${(await credit.text()).slice(0, 200)}`;
    const order = await admin('POST', `/_proxy-order/${salesChannelId}`, {}).catch(async e => {
        // The endpoint takes the context token as header.
        const res = await fetch(`${base}/api/_proxy-order/${salesChannelId}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'sw-context-token': token },
            body: '{}',
        });
        if (!res.ok) throw new Error(`${e.message}; retry with context token: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        return res.json();
    });
    return { orderNumber: order.orderNumber, creditNote };
}

async function main() {
    const tok = await fetch(`${base}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'password', client_id: 'administration', scopes: 'write', username: process.env.SOURCE_ADMIN_USER, password: process.env.SOURCE_ADMIN_PASSWORD }),
    });
    if (!tok.ok) throw new Error(`admin login: HTTP ${tok.status}`);
    adminToken = (await tok.json()).access_token;

    // --only-admin-orders re-runs step 3 alone; the other steps are not idempotent.
    const onlyAdminOrders = process.argv.includes('--only-admin-orders');
    const summary = { scenarios: {}, guestOrders: [], adminOrders: [], deletedProducts: [] };

    // 1. State scenarios over the demodata orders, in order-number order so reruns are stable.
    const orders = (await admin('POST', '/search/order', {
        limit: 500,
        sort: [{ field: 'orderNumber', order: 'ASC' }],
        associations: { transactions: {}, deliveries: {}, stateMachineState: {} },
    })).data;
    for (const [i, order] of onlyAdminOrders ? [] : orders.entries()) {
        if (order.stateMachineState?.technicalName !== 'open') continue;
        const scenario = CYCLE[i % CYCLE.length];
        await transitionOrder(order, scenario);
        summary.scenarios[scenario] = (summary.scenarios[scenario] ?? 0) + 1;
    }
    console.log('state scenarios', summary.scenarios);

    // 2. Guest orders through the Store API: one email ordering twice as a guest, and a guest
    // order with the email of a registered customer.
    const countries = (await store('POST', '/country', { filter: [{ type: 'equals', field: 'iso', value: 'DE' }] })).data.elements;
    const salutations = (await store('POST', '/salutation', {})).data.elements;
    const products = (await store('POST', '/product', { limit: 5, filter: [{ type: 'equals', field: 'childCount', value: 0 }] })).data.elements;
    const registered = (await admin('POST', '/search/customer', { limit: 1, filter: [{ type: 'equals', field: 'guest', value: false }], sort: [{ field: 'customerNumber', order: 'ASC' }] })).data[0];
    const guestInput = (email, i) => ({
        email, firstName: `Guest${i}`, lastName: 'Buyer', productId: products[i % products.length].id,
        countryId: countries[0].id, salutationId: salutations[0].id,
    });
    for (const [i, email] of ['guest.twice@example.com', 'guest.twice@example.com', registered.email, 'guest.once@example.com'].entries()) {
        if (onlyAdminOrders) break;
        summary.guestOrders.push({ email, orderNumber: await guestOrder(guestInput(email, i)) });
    }
    console.log('guest orders', summary.guestOrders);

    // 3. Admin orders with a custom and a credit line.
    const salesChannelId = (await store('GET', '/context')).data.salesChannel.id;
    for (let i = 0; i < 2; i++) {
        try {
            summary.adminOrders.push(await adminOrderWithCustomLines({ salesChannelId, customerId: registered.id, productId: products[(i + 2) % products.length].id }));
        } catch (e) {
            summary.adminOrders.push({ error: e.message });
        }
    }
    console.log('admin orders', summary.adminOrders);

    // 4. Delete three simple products that appear in orders, so order lines point at nothing.
    const lines = (await admin('POST', '/search/order-line-item', {
        limit: 200,
        filter: [{ type: 'equals', field: 'type', value: 'product' }, { type: 'equals', field: 'product.childCount', value: 0 }, { type: 'equals', field: 'product.parentId', value: null }],
        associations: { product: {} },
    })).data;
    const toDelete = [...new Set(lines.map(l => l.productId).filter(Boolean))].slice(0, 3);
    for (const id of onlyAdminOrders ? [] : toDelete) {
        await admin('DELETE', `/product/${id}`);
        summary.deletedProducts.push(id);
    }
    console.log('deleted products', summary.deletedProducts);
    console.log(JSON.stringify(summary));
}

main().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
