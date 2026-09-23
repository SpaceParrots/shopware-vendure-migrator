// Stage: compare Vendure's customers and orders with Shopware.
//
// Amounts, dates and emails are read from Shopware's MySQL again, not from sales-model.json, so a
// transform bug cannot hide itself. Vendure is read through its public APIs only: the Admin API
// for records, the Shop API for what a customer experiences (login, order history).
// Expected states and counts do come from the model, because they are mapping decisions.
import mysql from 'mysql2/promise';
import path from 'node:path';
import { SHOPWARE } from './config.mjs';
import { openBindings } from './lib/bindings.mjs';
import { log, readJson, toMinorUnits, writeJson } from './lib/util.mjs';
import { VendureClient } from './lib/vendure-client.mjs';

const LIVE = `UNHEX('${SHOPWARE.LIVE_VERSION}')`;
const SAMPLE = 5;

const ORDER_FIELDS = `code state active orderPlacedAt total totalWithTax couponCodes
    customer { emailAddress }
    lines { quantity productVariant { sku } }
    surcharges { priceWithTax }
    payments { method amount state refunds { total state } }
    fulfillments { state }
    taxSummary { taxRate taxTotal }
    customFields { shopwareId shopwareStates }`;

async function sourceFacts(config) {
    const conn = await mysql.createConnection({
        host: config.source.host, port: config.source.port, user: config.source.user, password: config.source.password,
        database: config.source.database, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    });
    try {
        const [orders] = await conn.query(`SELECT LOWER(HEX(o.id)) id, o.order_number, o.amount_total, o.amount_net, o.order_date_time, o.price,
                oc.email, (SELECT COUNT(*) FROM order_line_item li WHERE li.order_id = o.id AND li.version_id = ${LIVE} AND li.type = 'product') product_lines
            FROM \`order\` o JOIN order_customer oc ON oc.order_id = o.id AND oc.version_id = ${LIVE}
            WHERE o.version_id = ${LIVE}`);
        const [customers] = await conn.query(`SELECT LOWER(HEX(c.id)) id, c.email, c.guest, c.first_name, c.last_name,
                (SELECT COUNT(*) FROM customer_address a WHERE a.customer_id = c.id) addresses
            FROM customer c`);
        return { orders, customers };
    } finally {
        await conn.end();
    }
}

async function all(client, field, fields) {
    const items = [];
    for (let skip = 0; ; skip += 500) {
        const data = await client.gql(`query($skip: Int!) { ${field}(options: { skip: $skip, take: 500 }) { totalItems items { ${fields} } } }`, { skip });
        items.push(...data[field].items);
        if (items.length >= data[field].totalItems) return items;
    }
}

/** Logs a customer into the Shop API and reads their order history; null when the login fails. */
async function shopLogin(shopApi, email, password) {
    const res = await fetch(shopApi, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `mutation($u: String!, $p: String!) { login(username: $u, password: $p) {
            ... on CurrentUser { id } ... on ErrorResult { errorCode } } }`, variables: { u: email, p: password } }),
    });
    const body = await res.json();
    if (!body.data?.login?.id) return null;
    const token = res.headers.get('vendure-auth-token');
    const me = await fetch(shopApi, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: '{ activeCustomer { orders(options: { take: 1 }) { totalItems } } activeOrder { id } }' }),
    }).then(r => r.json());
    return { orders: me.data?.activeCustomer?.orders.totalItems, activeOrder: me.data?.activeOrder };
}

export async function verifySales(config, snapshotDir, { loginPassword = process.env.VERIFY_LOGIN_PASSWORD } = {}) {
    const model = await readJson(path.join(snapshotDir, 'sales-model.json'));
    const bindings = await openBindings(config, snapshotDir, { readOnly: true });
    const client = new VendureClient(config.target, config.http);
    await client.login();
    const shopApi = config.target.adminApi.replace(/admin-api$/, 'shop-api');
    const source = await sourceFacts(config);
    const checks = [];
    const check = (name, mismatches, total, extra = {}) => {
        checks.push({ name, pass: mismatches.length === 0, total, mismatches: mismatches.length, samples: mismatches.slice(0, SAMPLE), ...extra });
        log(`verify-sales ${mismatches.length ? 'FAIL' : 'ok  '} ${name}: ${mismatches.length} of ${total}`);
    };

    // ----- customers
    const customers = await all(client, 'customers', 'id emailAddress firstName lastName user { id verified } groups { name } addresses { id } customFields { shopwareId customerNumber }');
    const byShopwareId = new Map(customers.map(c => [c.customFields.shopwareId, c]));
    check('customers.count', customers.length === model.expected.customers ? [] : [{ expected: model.expected.customers, actual: customers.length }], 1);
    const sourceCustomers = new Map(source.customers.map(c => [c.id, c]));
    const customerMismatches = [];
    for (const m of model.customers) {
        const v = byShopwareId.get(m.sourceId);
        const s = sourceCustomers.get(m.sourceId);
        const problems = [];
        if (!v) problems.push('missing in Vendure');
        else {
            if (v.emailAddress !== s.email.trim().toLowerCase()) problems.push(`email ${v.emailAddress} vs ${s.email}`);
            if (v.firstName !== s.first_name || v.lastName !== s.last_name) problems.push('name');
            if (Boolean(v.user) === Boolean(Number(s.guest))) problems.push(`user ${Boolean(v.user)} for guest=${s.guest}`);
            if (!Number(s.guest) && v.addresses.length !== Number(s.addresses)) problems.push(`addresses ${v.addresses.length} vs ${s.addresses}`);
            if (!Number(s.guest) && v.groups.length !== 1) problems.push(`groups ${v.groups.length}`);
        }
        if (problems.length) customerMismatches.push({ sourceId: m.sourceId, problems });
    }
    check('customers.fields', customerMismatches, model.customers.length);
    const mergedAway = Object.entries(model.mergedInto).filter(([id, into]) => id !== into);
    check('customers.mergedRowsHaveNoOwnCustomer', mergedAway.filter(([id]) => byShopwareId.has(id)).map(([id]) => ({ sourceId: id })), mergedAway.length);

    // ----- orders
    const orders = await all(client, 'orders', ORDER_FIELDS);
    const byCode = new Map(orders.map(o => [o.code, o]));
    check('orders.count', orders.length === model.expected.orders ? [] : [{ expected: model.expected.orders, actual: orders.length }], 1);
    check('orders.noneActive', orders.filter(o => o.active).map(o => ({ code: o.code })), orders.length);
    const sourceOrders = new Map(source.orders.map(o => [o.order_number, o]));
    const modelOrders = new Map(model.orders.map(o => [o.code, o]));
    const amount = [], taxes = [], taxOneCent = [], dates = [], owners = [], shapes = [], states = [], payments = [];
    let centsOff = 0;
    for (const [code, s] of sourceOrders) {
        const v = byCode.get(code);
        const m = modelOrders.get(code);
        if (!v || !m) { amount.push({ code, problem: 'missing in Vendure or model' }); continue; }
        const gross = toMinorUnits(s.amount_total).minor;
        const net = toMinorUnits(s.amount_net).minor;
        if (v.totalWithTax !== gross || v.total !== net) {
            amount.push({ code, shopware: { gross, net }, vendure: { gross: v.totalWithTax, net: v.total } });
            centsOff += Math.abs(v.totalWithTax - gross);
        }
        const price = typeof s.price === 'string' ? JSON.parse(s.price) : s.price;
        const swTaxes = price.calculatedTaxes.map(t => ({ rate: Number(t.taxRate), tax: toMinorUnits(t.tax).minor })).filter(t => t.tax !== 0);
        const vTaxes = v.taxSummary.map(t => ({ rate: t.taxRate, tax: t.taxTotal })).filter(t => t.tax !== 0);
        // Vendure's tax summary is computed from the lines at read time, so the known one-cent
        // share difference (see sales-decisions.json, orders.totals) shows up here per rate.
        const rates = new Set([...swTaxes, ...vTaxes].map(t => t.rate));
        const worst = Math.max(0, ...[...rates].map(r => Math.abs((swTaxes.find(t => t.rate === r)?.tax ?? 0) - (vTaxes.find(t => t.rate === r)?.tax ?? 0))));
        if (worst > 1) taxes.push({ code, shopware: swTaxes, vendure: vTaxes });
        else if (worst === 1) taxOneCent.push(code);
        if (new Date(`${s.order_date_time}Z`).getTime() !== new Date(v.orderPlacedAt).getTime()) dates.push({ code, shopware: s.order_date_time, vendure: v.orderPlacedAt });
        if (v.customer?.emailAddress !== s.email.trim().toLowerCase()) owners.push({ code, shopware: s.email, vendure: v.customer?.emailAddress });
        if (v.lines.length !== Number(s.product_lines) || v.surcharges.length !== m.surcharges.length) shapes.push({ code, lines: [v.lines.length, Number(s.product_lines)], surcharges: [v.surcharges.length, m.surcharges.length] });
        const fulfillment = v.fulfillments[0]?.state ?? null;
        if (v.state !== m.state || fulfillment !== (m.fulfillment?.state ?? null) || v.customFields.shopwareStates !== m.shopwareStates) {
            states.push({ code, expected: [m.state, m.fulfillment?.state ?? null], actual: [v.state, fulfillment] });
        }
        const last = v.payments[v.payments.length - 1];
        const lastModel = m.payments[m.payments.length - 1];
        const refunded = last?.refunds.reduce((n, r) => n + r.total, 0) ?? 0;
        if (!last || last.state !== lastModel.state || last.amount !== gross || refunded !== (m.refund?.amount ?? 0)) {
            payments.push({ code, expected: [lastModel.state, gross, m.refund?.amount ?? 0], actual: last ? [last.state, last.amount, refunded] : null });
        }
    }
    check('orders.totalsMatchShopware', amount, sourceOrders.size, { grossCentsOff: centsOff });
    check('orders.taxPerRateWithinOneCentOfShopware', taxes, sourceOrders.size, { oneCentDeviations: taxOneCent.length, oneCentSamples: taxOneCent.slice(0, SAMPLE) });
    check('orders.placedAtMatchesShopware', dates, sourceOrders.size);
    check('orders.customerMatchesShopware', owners, sourceOrders.size);
    check('orders.lineAndSurchargeCounts', shapes, sourceOrders.size);
    check('orders.statesAsMapped', states, sourceOrders.size);
    check('orders.paymentsAndRefunds', payments, sourceOrders.size);
    const placeholderLines = orders.flatMap(o => o.lines).filter(l => l.productVariant.sku === 'SHOPWARE-ARCHIVED').length;
    check('orders.placeholderLines', placeholderLines === model.expected.placeholderLines ? [] : [{ expected: model.expected.placeholderLines, actual: placeholderLines }], 1);

    // ----- no stock side effects
    const variants = await all(client, 'productVariants', 'sku stockAllocated');
    check('stock.nothingAllocated', variants.filter(v => v.stockAllocated !== 0).map(v => ({ sku: v.sku, allocated: v.stockAllocated })), variants.length);

    // ----- what a customer experiences: login with the migrated hash, order history, no cart
    if (loginPassword) {
        const ordersPerCustomer = new Map();
        for (const o of model.orders) ordersPerCustomer.set(o.customerSourceId, (ordersPerCustomer.get(o.customerSourceId) ?? 0) + 1);
        const registered = model.customers.filter(c => !c.guest && c.passwordHash);
        const logins = [];
        for (const c of registered) {
            const r = await shopLogin(shopApi, c.email, loginPassword);
            const expectedOrders = ordersPerCustomer.get(c.sourceId) ?? 0;
            if (!r) logins.push({ email: c.email, problem: 'login failed' });
            else if (r.orders !== expectedOrders || r.activeOrder) logins.push({ email: c.email, orders: [r.orders, expectedOrders], activeOrder: r.activeOrder });
        }
        check('shop.loginAndOrderHistory', logins, registered.length);
        const wrong = registered.length ? await shopLogin(shopApi, registered[0].email, `${loginPassword}-wrong`) : null;
        check('shop.wrongPasswordRefused', wrong ? [{ email: registered[0].email }] : [], 1);
    } else {
        log('verify-sales: VERIFY_LOGIN_PASSWORD not set, login checks skipped');
    }

    const report = {
        generatedAt: new Date().toISOString(),
        target: config.target.label,
        bindings: bindings.size,
        passed: checks.filter(c => c.pass).length,
        failed: checks.filter(c => !c.pass).length,
        checks,
    };
    await writeJson(path.join(snapshotDir, 'verify-sales-report.json'), report);
    log(`verify-sales: ${report.passed} of ${checks.length} checks passed`);
    return report;
}
