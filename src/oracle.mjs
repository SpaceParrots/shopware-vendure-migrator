// Independent check against Shopware itself, not against the migrator's own model.
//  - Admin API with `sw-inheritance: 1` returns Shopware's resolved base price, tax and active flag.
//    That validates the migrator's inheritance resolver.
//  - Store API returns the price a guest actually sees (rule prices applied, quantity 1) and the
//    resolved translated name. That measures the customer-visible effect of the rule-price gap.
import mysql from 'mysql2/promise';
import path from 'node:path';
import { SHOPWARE } from './config.mjs';
import { openBindings } from './lib/bindings.mjs';
import { request } from './lib/http.mjs';
import { log, readJson, toMinorUnits, writeJson } from './lib/util.mjs';
import { VendureClient } from './lib/vendure-client.mjs';
import { channelPrice } from './load/context.mjs';
import { resolvePrice } from './transform/prices.mjs';

const PAGE_ADMIN = 500;
const PAGE_STORE = 100;

// Every Shopware call here reads, so each may retry; the token request only opens a session.
const post = (http, url, headers, body) => request(url, {
    ...http,
    method: 'POST',
    retry: true,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
});

async function shopwareAdminToken(http, base, source) {
    const { data: body } = await post(http, `${base}/api/oauth/token`, {}, {
        grant_type: 'password',
        client_id: 'administration',
        username: source.adminUser,
        password: source.adminPassword,
        scope: 'write',
    });
    if (!body?.access_token) throw new Error(`Shopware admin login at ${base} failed: ${JSON.stringify(body).slice(0, 200)}`);
    return body.access_token;
}

async function adminProducts(http, base, token) {
    const out = [];
    for (let page = 1; ; page++) {
        const { data: body } = await post(
            http, `${base}/api/search/product`, { authorization: `Bearer ${token}`, 'sw-inheritance': '1' },
            { limit: PAGE_ADMIN, page, includes: { product: ['id', 'productNumber', 'price', 'taxId', 'active', 'parentId'] } },
        );
        if (!Array.isArray(body?.data)) throw new Error(`Admin API search failed: ${JSON.stringify(body).slice(0, 200)}`);
        out.push(...body.data);
        if (body.data.length < PAGE_ADMIN) return out;
    }
}

async function storeProducts(http, base, accessKey) {
    const out = [];
    for (let page = 1; ; page++) {
        // No `includes`: the filter empties `translated`, which has no apiAlias of its own.
        const { data: body } = await post(http, `${base}/store-api/product`, { 'sw-access-key': accessKey }, { limit: PAGE_STORE, page });
        if (!Array.isArray(body?.elements)) throw new Error(`Store API failed: ${JSON.stringify(body).slice(0, 200)}`);
        out.push(...body.elements);
        if (body.elements.length < PAGE_STORE) return out;
    }
}

async function vendureVariants(client) {
    const out = [];
    for (let skip = 0; ; skip += 100) {
        const { productVariants } = await client.gql(
            `query($skip: Int!) { productVariants(options: { take: 100, skip: $skip }) { totalItems items {
                id sku name price priceWithTax enabled product { name } } } }`,
            { skip },
        );
        out.push(...productVariants.items);
        if (out.length >= productVariants.totalItems || !productVariants.items.length) return out;
    }
}

/**
 * Compares every model offer with Shopware's Admin API (resolved base price, tax, active flag),
 * the Store API (name, guest price) and the Vendure variant bound to it. Prices are compared in
 * the channel mode, `model.pricesIncludeTax`: gross when the channel shows gross prices, else net.
 *
 * Offers transform refused on purpose (gaps.problems.refusedOffers) are counted in
 * `refusedOffers`. Load does not create them, so one missing in Vendure is expected and not
 * compared; one that is in Vendure anyway is compared like any other offer.
 * @param {{ refusedSourceIds?: Set<string> }} input Besides the model, bindings and the three
 *   API results: the source ids of the refused offers.
 * @returns {{ r: object, guestTier1: Map<string, number|null> }} `r` holds the counts and lists
 *   of the report, and `priceField` ('gross' or 'net'); `guestTier1` the observed quantity-1 rule
 *   price per product, or null.
 */
export function compareOffers({ model, bindings, admin, store, vendure, refusedSourceIds = new Set() }) {
    const adminById = new Map(admin.map(p => [p.id, p]));
    const storeById = new Map(store.map(p => [p.id, p]));
    const vendureById = new Map(vendure.map(v => [String(v.id), v]));
    // The channel mode picks the price the shop shows, as in load and verify: gross is
    // priceWithTax, net is price.
    const vendurePrice = v => (model.pricesIncludeTax ? v.priceWithTax : v.price);
    const r = {
        compared: 0,
        refusedOffers: 0,
        priceField: model.pricesIncludeTax ? 'gross' : 'net',
        resolver: { basePriceMismatch: [], taxMismatch: [], activeMismatch: [], missingInAdminApi: [], missingInVendure: [] },
        names: { mismatch: [], notInStoreApi: 0 },
        guestPrice: { comparable: 0, equal: 0, different: 0, higherInShopware: 0, lowerInShopware: 0, maxAbsDiffMinor: 0, sumAbsDiffMinor: 0, withTierPrices: 0, examples: [] },
    };
    const guestTier1 = new Map();
    for (const family of model.families) {
        for (const o of family.offers) {
            const v = vendureById.get(bindings.get('product', o.sourceId, 'variant'));
            const a = adminById.get(o.sourceId);
            const s = storeById.get(o.sourceId);
            if (refusedSourceIds.has(o.sourceId)) {
                r.refusedOffers++;
                // A documented data problem, not a resolver mismatch; verify reports it as missing.
                if (!v) continue;
            }
            r.compared++;
            // Counted on its own: otherwise a missing variant only lowers the comparable counts.
            if (!v) r.resolver.missingInVendure.push(o.sku);
            if (!a) { r.resolver.missingInAdminApi.push(o.sku); continue; }

            // Resolver check: Shopware's own inheritance vs the migrator's.
            // The price is the one load sends for the channel mode, gross or net. Converted by
            // transform's rule, so a linked sub-cent price that transform rounds on purpose is not
            // reported as a resolver mismatch; the check is about inheritance.
            const priceEntry = (a.price ?? []).find(p => p.currencyId === SHOPWARE.CURRENCY);
            const pricing = { currencyId: SHOPWARE.CURRENCY, decimals: model.currencyDecimals ?? 2, pricesIncludeTax: model.pricesIncludeTax };
            const shopwarePrice = priceEntry ? channelPrice(model, resolvePrice({ [`c${SHOPWARE.CURRENCY}`]: priceEntry }, pricing)) : null;
            const modelPrice = channelPrice(model, o);
            if (shopwarePrice !== modelPrice || (v && vendurePrice(v) !== shopwarePrice)) {
                r.resolver.basePriceMismatch.push({ sku: o.sku, shopware: shopwarePrice, model: modelPrice, vendure: v ? vendurePrice(v) : undefined });
            }
            if (a.taxId !== o.taxSourceId) r.resolver.taxMismatch.push({ sku: o.sku, shopware: a.taxId, model: o.taxSourceId });
            if (Boolean(a.active) !== o.enabled) r.resolver.activeMismatch.push({ sku: o.sku, shopware: a.active, model: o.enabled });

            // Names: Store API translated name (default language) vs Vendure.
            if (!s) { r.names.notInStoreApi++; continue; }
            const shopName = s.translated?.name;
            const vendureName = family.kind === 'family' ? v?.name : v?.product.name;
            const nameOk = family.kind === 'family' ? vendureName?.startsWith(shopName ?? '\u0000') : vendureName === shopName;
            if (!nameOk) r.names.mismatch.push({ sku: o.sku, shopware: shopName, vendure: vendureName });

            // Gap measurement: what a guest pays in Shopware vs the base price Vendure charges.
            // calculatedPrice is always the BASE price; rule prices live in calculatedPrices, sorted by
            // quantity, and the first tier covers quantity 1. That is what the storefront shows, gross
            // or net by the same channel mode, so it is compared with the channel-mode Vendure price.
            const tiers = s.calculatedPrices ?? [];
            const guest = toMinorUnits(tiers.length ? tiers[0].unitPrice : s.calculatedPrice?.unitPrice);
            if (!guest.ok || !v) continue;
            r.guestPrice.comparable++;
            if (tiers.length) r.guestPrice.withTierPrices++;
            guestTier1.set(o.sourceId, tiers.length ? guest.minor : null);
            const diff = guest.minor - vendurePrice(v);
            if (diff === 0) r.guestPrice.equal++;
            else {
                r.guestPrice.different++;
                if (diff > 0) r.guestPrice.higherInShopware++;
                else r.guestPrice.lowerInShopware++;
                r.guestPrice.maxAbsDiffMinor = Math.max(r.guestPrice.maxAbsDiffMinor, Math.abs(diff));
                r.guestPrice.sumAbsDiffMinor += Math.abs(diff);
                if (r.guestPrice.examples.length < 5) r.guestPrice.examples.push({ sku: o.sku, shopwareGuest: guest.minor, vendure: vendurePrice(v) });
            }
        }
    }
    return { r, guestTier1 };
}

/**
 * Reads each product's quantity-1 rule prices and all rules from the Shopware database.
 * @param {'gross'|'net'} priceField The channel-mode price, the one the Store API shows a guest.
 */
async function rulePriceRows(connect, source, priceField) {
    const conn = await connect({
        host: source.host, port: source.port, user: source.user,
        password: source.password, database: source.database, charset: 'utf8mb4',
    });
    try {
        const [tier1Rows] = await conn.execute(
            `SELECT LOWER(HEX(product_id)) product_id, LOWER(HEX(rule_id)) rule_id, JSON_EXTRACT(price, ?) price
             FROM product_price WHERE quantity_start = 1 AND product_version_id = UNHEX(?)`,
            [`$.c${SHOPWARE.CURRENCY}.${priceField}`, SHOPWARE.LIVE_VERSION],
        );
        const [rules] = await conn.execute('SELECT LOWER(HEX(id)) id, name, priority FROM rule');
        return { tier1Rows, rules };
    } finally {
        await conn.end();
    }
}

/**
 * Which rule won? Match the observed tier-1 price against each rule's tier-1 price for the
 * product. Then test the claim: the winner is the first rule by (priority DESC, id ASC) among
 * the rules proven to match a guest, i.e. rules observed winning somewhere.
 */
export function ruleSelection(guestTier1, tier1Rows, rules) {
    const ruleById = new Map(rules.map(x => [x.id, x]));
    const tier1ByProduct = new Map();
    for (const row of tier1Rows) {
        if (!tier1ByProduct.has(row.product_id)) tier1ByProduct.set(row.product_id, []);
        tier1ByProduct.get(row.product_id).push({ ruleId: row.rule_id, minor: toMinorUnits(row.price).minor });
    }
    const order = (a, b) => ruleById.get(b).priority - ruleById.get(a).priority || (a < b ? -1 : a > b ? 1 : 0);
    const observed = new Map(); // productId -> winning ruleId
    const ambiguous = [];
    for (const [productId, minor] of guestTier1) {
        if (minor === null) continue;
        const candidates = (tier1ByProduct.get(productId) ?? []).filter(t => t.minor === minor);
        if (candidates.length === 1) observed.set(productId, candidates[0].ruleId);
        else ambiguous.push(productId);
    }
    const provenMatching = new Set(observed.values());
    let agree = 0;
    const disagree = [];
    for (const [productId, winner] of observed) {
        const eligible = (tier1ByProduct.get(productId) ?? []).map(t => t.ruleId).filter(id => provenMatching.has(id)).sort(order);
        if (eligible[0] === winner) agree++;
        else disagree.push({ productId, observed: ruleById.get(winner)?.name, predicted: ruleById.get(eligible[0])?.name });
    }
    // Keyed by rule id: two rules may share a name. The name stays for reading.
    const winnerTally = {};
    for (const id of observed.values()) {
        winnerTally[id] ??= { name: ruleById.get(id)?.name, count: 0 };
        winnerTally[id].count++;
    }
    return {
        productsWithObservedWinner: observed.size,
        ambiguousPriceMatch: ambiguous.length,
        rulesProvenToMatchGuest: [...provenMatching].sort(order).map(id => `${ruleById.get(id).name} (priority ${ruleById.get(id).priority}, id ${id})`),
        predictionAgrees: agree,
        predictionDisagrees: disagree.length,
        disagreeExamples: disagree.slice(0, 5),
        winnerTally,
    };
}

/**
 * Compares the model and Vendure with Shopware's own Admin and Store API and writes the report.
 *
 * Side effects: reads model.json, gaps.json, bindings.json and every snapshot's load journal
 * read-only; logs in to
 * Shopware and Vendure; reads the `product_price` and `rule` tables; writes
 * `<snapshot>/oracle-report.json`. Changes nothing in Shopware or Vendure.
 *
 * @param {ReturnType<import('./config.mjs').loadConfig>} config Needs the source database, the
 *   Shopware admin user and store access key, and Vendure.
 * @param {string} snapshotDir Snapshot holding model.json and gaps.json.
 * @param {{ client?: VendureClient, fetch?: typeof fetch, connect?: typeof mysql.createConnection }} [deps]
 *   Replacements for tests.
 * @returns {Promise<object>} The report. `resolverMismatches` counts every entry under `resolver`;
 *   offers in gaps.problems.refusedOffers are counted in `refusedOffers` instead.
 * @throws {Error} When a login fails, an API answers with an error, or bindings.json belongs to
 *   another Vendure.
 */
export async function oracle(config, snapshotDir, deps = {}) {
    const base = config.source.mediaBaseUrl.replace(/\/$/, '');
    const http = { ...config.http, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
    const model = await readJson(path.join(snapshotDir, 'model.json'));
    const gaps = await readJson(path.join(snapshotDir, 'gaps.json'));
    const refusedSourceIds = new Set((gaps.problems?.refusedOffers ?? []).map(x => x.sourceId));
    const bindings = await openBindings(config, snapshotDir, { readOnly: true });
    const client = deps.client ?? new VendureClient(config.target, http);
    await client.login();

    const token = await shopwareAdminToken(http, base, config.source);
    const [admin, store, vendure] = await Promise.all([
        adminProducts(http, base, token),
        storeProducts(http, base, config.source.storeAccessKey),
        vendureVariants(client),
    ]);
    log(`oracle: shopware admin ${admin.length}, store ${store.length}, vendure variants ${vendure.length}`);
    const { r, guestTier1 } = compareOffers({ model, bindings, admin, store, vendure, refusedSourceIds });

    const { tier1Rows, rules } = await rulePriceRows(deps.connect ?? mysql.createConnection, config.source, r.priceField);
    r.ruleSelection = ruleSelection(guestTier1, tier1Rows, rules);
    const sel = r.ruleSelection;
    log(`oracle rule selection: observed winner for ${sel.productsWithObservedWinner} products (${sel.ambiguousPriceMatch} ambiguous); priority DESC, id ASC predicts ${sel.predictionAgrees}, misses ${sel.predictionDisagrees}`);
    log(`oracle winners: ${JSON.stringify(sel.winnerTally)}`);

    const measuredAt = new Date();
    const result = {
        measuredAt: measuredAt.toISOString(),
        weekdayInShopTimezone: new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/Berlin' }).format(measuredAt),
        context: 'Store API guest context of the storefront sales channel, quantity 1',
        resolverMismatches: Object.values(r.resolver).reduce((n, list) => n + list.length, 0),
        ...r,
    };
    await writeJson(path.join(snapshotDir, 'oracle-report.json'), result);
    log(`oracle resolver (${r.priceField} prices): basePrice mismatches ${r.resolver.basePriceMismatch.length}, tax ${r.resolver.taxMismatch.length}, active ${r.resolver.activeMismatch.length}, missing in admin api ${r.resolver.missingInAdminApi.length}, missing in vendure ${r.resolver.missingInVendure.length}; refused by transform ${r.refusedOffers} (not mismatches)`);
    log(`oracle names: mismatches ${r.names.mismatch.length}, not in store api ${r.names.notInStoreApi}`);
    log(`oracle guest price (${result.weekdayInShopTimezone}): comparable ${r.guestPrice.comparable}, equal ${r.guestPrice.equal}, different ${r.guestPrice.different} (higher in Shopware ${r.guestPrice.higherInShopware}, lower ${r.guestPrice.lowerInShopware}), max diff ${r.guestPrice.maxAbsDiffMinor}`);
    return result;
}
