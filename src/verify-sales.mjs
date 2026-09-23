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
import { normalizeEmail } from './transform/customers.mjs';

const LIVE = `UNHEX('${SHOPWARE.LIVE_VERSION}')`;
const SAMPLE = 5;
// mysql2 returns MariaDB JSON columns as text or as parsed objects depending on the server.
const parse = json => (typeof json === 'string' ? JSON.parse(json) : json);

const ORDER_FIELDS = `code state active orderPlacedAt total totalWithTax shippingWithTax couponCodes
    customer { emailAddress }
    lines { quantity linePriceWithTax productVariant { sku } }
    surcharges { priceWithTax }
    payments { id method amount state refunds { total state } }
    fulfillments { state }
    taxSummary { taxRate taxTotal }
    customFields { shopwareId shopwareStates }`;

async function sourceFacts(config) {
    const conn = await mysql.createConnection({
        host: config.source.host, port: config.source.port, user: config.source.user, password: config.source.password,
        database: config.source.database, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    });
    try {
        const [orders] = await conn.query(`SELECT LOWER(HEX(o.id)) id, o.order_number, o.amount_total, o.amount_net, o.order_date_time, o.price, o.item_rounding,
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

/** One Shop API request; throws on a non-2xx answer or after the timeout. */
async function shopRequest(shopApi, timeoutMs, query, variables, token) {
    const res = await fetch(shopApi, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Shop API ${shopApi}: HTTP ${res.status}`);
    return { body: await res.json(), token: res.headers.get('vendure-auth-token') };
}

/**
 * Logs a customer into the Shop API and reads their order history.
 * @returns {Promise<{ orders: number, activeOrder: object|null } | null>} null when the login is refused.
 * @throws {Error} On a non-2xx answer or a timeout.
 */
async function shopLogin(shopApi, timeoutMs, email, password) {
    const login = await shopRequest(shopApi, timeoutMs, `mutation($u: String!, $p: String!) { login(username: $u, password: $p) {
        ... on CurrentUser { id } ... on ErrorResult { errorCode } } }`, { u: email, p: password });
    if (!login.body.data?.login?.id) return null;
    const me = await shopRequest(shopApi, timeoutMs, '{ activeCustomer { orders(options: { take: 1 }) { totalItems } } activeOrder { id } }', {}, login.token);
    return { orders: me.body.data?.activeCustomer?.orders.totalItems, activeOrder: me.body.data?.activeOrder };
}

/**
 * Compares Vendure's customers and orders with Shopware and writes verify-sales-report.json.
 * Changes nothing in Shopware or Vendure (Shop API logins open sessions only).
 *
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {string} snapshotDir Snapshot folder holding sales-model.json.
 * @param {{ loginPassword?: string }} [options] Password every registered customer is expected to
 *   log in with; the login checks are skipped without it.
 * @returns {Promise<{ passed: number, failed: number, checks: object[] }>}
 * @throws {Error} When sales-model.json cannot be read, the Vendure login or MySQL connection
 *   fails, or an API answers with an error.
 */
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
        else if (!s) problems.push('no longer in Shopware');
        else {
            if (v.emailAddress !== normalizeEmail(s.email)) problems.push(`email ${v.emailAddress} vs ${s.email}`);
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
    const byShopwareOrderId = new Map(orders.map(o => [o.customFields.shopwareId, o]));
    check('orders.count', orders.length === model.expected.orders ? [] : [{ expected: model.expected.orders, actual: orders.length }], 1);
    check('orders.noneActive', orders.filter(o => o.active).map(o => ({ code: o.code })), orders.length);
    const sourceOrders = new Map(source.orders.map(o => [o.id, o]));
    const modelIds = new Set(model.orders.map(o => o.sourceId));
    // Refused in transform, or placed after the snapshot: listed, not compared.
    const notInModel = source.orders.filter(o => !modelIds.has(o.id)).map(o => o.order_number);
    const amount = [], sums = [], taxes = [], taxOneCent = [], dates = [], owners = [], shapes = [], states = [], payments = [];
    let centsOff = 0;
    for (const m of model.orders) {
        const { code } = m;
        const v = byShopwareOrderId.get(m.sourceId);
        const s = sourceOrders.get(m.sourceId);
        if (!v || !s) { amount.push({ code, problem: v ? 'no longer in Shopware' : 'missing in Vendure' }); continue; }
        // Independent of the stored totals: what Vendure computes from the order's own lines,
        // surcharges and shipping. load-sales allows one minor unit per surcharge (share rounding).
        const parts = v.lines.reduce((n, l) => n + l.linePriceWithTax, 0) + v.surcharges.reduce((n, x) => n + x.priceWithTax, 0) + v.shippingWithTax;
        if (Math.abs(parts - v.totalWithTax) > v.surcharges.length) sums.push({ code, parts, totalWithTax: v.totalWithTax });
        // The order's own rounding, as transform uses it.
        const decimals = parse(s.item_rounding)?.decimals ?? 2;
        const minor = x => toMinorUnits(x, decimals).minor;
        const gross = minor(s.amount_total);
        const net = minor(s.amount_net);
        if (v.totalWithTax !== gross || v.total !== net) {
            amount.push({ code, shopware: { gross, net }, vendure: { gross: v.totalWithTax, net: v.total } });
            centsOff += Math.abs(v.totalWithTax - gross);
        }
        const swTaxes = parse(s.price).calculatedTaxes.map(t => ({ rate: Number(t.taxRate), tax: minor(t.tax) })).filter(t => t.tax !== 0);
        const vTaxes = v.taxSummary.map(t => ({ rate: t.taxRate, tax: t.taxTotal })).filter(t => t.tax !== 0);
        // Vendure's tax summary is computed from the lines at read time, so the known one-cent
        // share difference (see sales-decisions.json, orders.totals) shows up here per rate.
        const rates = new Set([...swTaxes, ...vTaxes].map(t => t.rate));
        const worst = Math.max(0, ...[...rates].map(r => Math.abs((swTaxes.find(t => t.rate === r)?.tax ?? 0) - (vTaxes.find(t => t.rate === r)?.tax ?? 0))));
        if (worst > 1) taxes.push({ code, shopware: swTaxes, vendure: vTaxes });
        else if (worst === 1) taxOneCent.push(code);
        if (new Date(`${s.order_date_time}Z`).getTime() !== new Date(v.orderPlacedAt).getTime()) dates.push({ code, shopware: s.order_date_time, vendure: v.orderPlacedAt });
        if (v.customer?.emailAddress !== normalizeEmail(s.email)) owners.push({ code, shopware: s.email, vendure: v.customer?.emailAddress });
        if (v.lines.length !== Number(s.product_lines) || v.surcharges.length !== m.surcharges.length) shapes.push({ code, lines: [v.lines.length, Number(s.product_lines)], surcharges: [v.surcharges.length, m.surcharges.length] });
        const fulfillment = v.fulfillments[0]?.state ?? null;
        if (v.state !== m.state || fulfillment !== (m.fulfillment?.state ?? null) || v.customFields.shopwareStates !== m.shopwareStates) {
            states.push({ code, expected: [m.state, m.fulfillment?.state ?? null], actual: [v.state, fulfillment] });
        }
        // Created in Shopware's order, so the highest id is the latest; the API promises no order.
        const last = [...v.payments].sort((a, b) => Number(a.id) - Number(b.id)).pop();
        const lastModel = m.payments[m.payments.length - 1];
        const refunded = last?.refunds.reduce((n, r) => n + r.total, 0) ?? 0;
        if (!last || last.state !== lastModel.state || last.amount !== gross || refunded !== (m.refund?.amount ?? 0)) {
            payments.push({ code, expected: [lastModel.state, gross, m.refund?.amount ?? 0], actual: last ? [last.state, last.amount, refunded] : null });
        }
    }
    const loadResult = await readJson(path.join(snapshotDir, 'load-sales-result.json')).catch(() => null);
    const compared = model.orders.length;
    check('orders.totalsMatchShopware', amount, compared, {
        grossCentsOff: centsOff,
        totalsFromInvoice: loadResult?.totalsFromInvoice?.length ?? null,
        notInModel: notInModel.length,
        notInModelSamples: notInModel.slice(0, SAMPLE),
    });
    check('orders.partsAddUpToTotal', sums, compared);
    check('orders.taxPerRateWithinOneCentOfShopware', taxes, compared, { oneCentDeviations: taxOneCent.length, oneCentSamples: taxOneCent.slice(0, SAMPLE) });
    check('orders.placedAtMatchesShopware', dates, compared);
    check('orders.customerMatchesShopware', owners, compared);
    check('orders.lineAndSurchargeCounts', shapes, compared);
    check('orders.statesAsMapped', states, compared);
    check('orders.paymentsAndRefunds', payments, compared);
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
            const r = await shopLogin(shopApi, config.http.timeoutMs, c.email, loginPassword);
            const expectedOrders = ordersPerCustomer.get(c.sourceId) ?? 0;
            if (!r) logins.push({ email: c.email, problem: 'login failed' });
            else if (r.orders !== expectedOrders || r.activeOrder) logins.push({ email: c.email, orders: [r.orders, expectedOrders], activeOrder: r.activeOrder });
        }
        check('shop.loginAndOrderHistory', logins, registered.length);
        const wrong = registered.length ? await shopLogin(shopApi, config.http.timeoutMs, registered[0].email, `${loginPassword}-wrong`) : null;
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
