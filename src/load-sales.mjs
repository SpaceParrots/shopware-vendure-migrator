// Stage: customers and orders into Vendure, in-process.
//
// The catalogue goes through the Admin API. Customers and orders cannot: the API cannot take a
// password hash or create a guest, and it has no order import (draft orders reprice lines, stamp
// today's date and a new code, and allocate stock). This stage therefore boots Vendure from the
// target's own config (VENDURE_CONFIG) and writes entities through its TypeORM connection, inside
// one transaction per customer and per order, without publishing events.
//
// Bindings, journal and skip-if-bound work as in `load`, so a re-run continues where it stopped.
import { createRequire } from 'node:module';
import path from 'node:path';
import { openBindings } from './lib/bindings.mjs';
import { log, readJson, writeJson } from './lib/util.mjs';

const PLACEHOLDER = { sku: 'SHOPWARE-ARCHIVED', name: 'Archived Shopware product', slug: 'archived-shopware-product' };

/**
 * Boots Vendure with the target's config, without the job queue and without an HTTP server.
 * @param {string} configPath CommonJS module exporting `config`.
 */
async function bootVendure(configPath) {
    const require = createRequire(path.resolve(configPath));
    const core = require('@vendure/core');
    const { config } = require(path.resolve(configPath));
    const app = await core.bootstrapWorker(config);
    return { core, app: app.app };
}

export async function loadSales(config, snapshotDir) {
    const startedAt = new Date().toISOString();
    const model = await readJson(path.join(snapshotDir, 'sales-model.json'));
    const bindings = await openBindings(config, snapshotDir);
    const { core, app } = await bootVendure(config.target.configPath);
    const failures = [];
    const totalsFromInvoice = [];
    const counts = {};
    const timings = {};
    try {
        const connection = app.get(core.TransactionalConnection);
        const ds = connection.rawConnection;
        const channel = await app.get(core.ChannelService).getDefaultChannel();
        const ctx = new core.RequestContext({ apiType: 'admin', isAuthorized: true, authorizedAsOwnerOnly: false, channel });
        const step = async (name, run) => {
            const t0 = Date.now();
            const c = { created: 0, skipped: 0, failed: 0 };
            counts[name] = c;
            try {
                await run(c);
            } finally {
                await bindings.flush();
                timings[name] = Date.now() - t0;
                log(`load-sales ${name}: ${JSON.stringify(c)} (${timings[name]} ms)`);
            }
        };
        const fail = (stepName, sourceId, e, c) => {
            c.failed++;
            failures.push({ step: stepName, sourceId, message: e.message });
        };

        await step('customerGroups', async c => {
            const service = app.get(core.CustomerGroupService);
            for (const g of model.customerGroups) {
                if (bindings.get('customerGroup', g.sourceId, 'customerGroup')) { c.skipped++; continue; }
                try {
                    const created = await service.create(ctx, { name: g.name });
                    await bindings.set('customerGroup', g.sourceId, 'customerGroup', created.id);
                    c.created++;
                } catch (e) { fail('customerGroups', g.sourceId, e, c); }
            }
        });

        await step('customers', async c => {
            const customerRole = await app.get(core.RoleService).getCustomerRole(ctx);
            const countries = new Map((await ds.getRepository(core.Country).find()).map(x => [x.code, x]));
            for (const cu of model.customers) {
                if (bindings.get('customer', cu.sourceId, 'customer')) { c.skipped++; continue; }
                try {
                    const id = await ds.transaction(async m => {
                        let user;
                        if (!cu.guest) {
                            user = await m.save(new core.User({
                                identifier: cu.email, verified: cu.verified, roles: [customerRole],
                                lastLogin: cu.lastLogin ? new Date(`${cu.lastLogin}Z`) : null,
                            }));
                            if (cu.passwordHash) {
                                await m.save(new core.NativeAuthenticationMethod({ identifier: cu.email, passwordHash: cu.passwordHash, user }));
                            }
                        }
                        const groups = cu.groupSourceIds.map(g => ({ id: bindings.get('customerGroup', g, 'customerGroup') })).filter(g => g.id);
                        const customer = await m.save(new core.Customer({
                            emailAddress: cu.email, title: cu.title ?? '', firstName: cu.firstName ?? '', lastName: cu.lastName ?? '',
                            phoneNumber: cu.phoneNumber ?? '', user, channels: [channel], groups,
                            customFields: { shopwareId: cu.sourceId, customerNumber: cu.customerNumber },
                            createdAt: new Date(`${cu.createdAt}Z`),
                        }));
                        for (const a of cu.addresses) {
                            const country = countries.get(a.countryCode);
                            if (!country) throw new Error(`address ${a.sourceId}: country ${a.countryCode} not in Vendure`);
                            await m.save(new core.Address({
                                customer, fullName: a.fullName, company: a.company ?? '', streetLine1: a.streetLine1, streetLine2: a.streetLine2 ?? '',
                                city: a.city, province: a.province ?? '', postalCode: a.postalCode ?? '', country, phoneNumber: a.phoneNumber ?? '',
                                defaultShippingAddress: a.defaultShippingAddress, defaultBillingAddress: a.defaultBillingAddress,
                            }));
                        }
                        return customer.id;
                    });
                    await bindings.set('customer', cu.sourceId, 'customer', id);
                    c.created++;
                } catch (e) { fail('customers', cu.sourceId, e, c); }
            }
        });

        await step('shippingMethods', async c => {
            const service = app.get(core.ShippingMethodService);
            for (const s of model.shippingMethods) {
                if (bindings.get('shippingMethod', s.sourceId, 'shippingMethod')) { c.skipped++; continue; }
                try {
                    // Only for the record: imported orders point at it. Created disabled for checkout
                    // by a checker nobody can pass, since its real price rules are not migrated.
                    const created = await service.create(ctx, {
                        code: `shopware-${s.code}`,
                        fulfillmentHandler: 'manual-fulfillment',
                        checker: { code: 'default-shipping-eligibility-checker', arguments: [{ name: 'orderMinimum', value: '999999999' }] },
                        calculator: { code: 'default-shipping-calculator', arguments: [{ name: 'rate', value: '0' }, { name: 'includesTax', value: 'auto' }, { name: 'taxRate', value: '0' }] },
                        translations: [{ languageCode: 'en', name: `${s.name} (Shopware)`, description: 'Imported for historical orders.' }],
                    });
                    await bindings.set('shippingMethod', s.sourceId, 'shippingMethod', created.id);
                    c.created++;
                } catch (e) { fail('shippingMethods', s.sourceId, e, c); }
            }
        });

        await step('placeholder', async c => {
            if (bindings.get('placeholder', PLACEHOLDER.sku, 'variant')) { c.skipped++; return; }
            const taxCategory = await ds.getRepository(core.TaxCategory).findOne({ where: { isDefault: true } }) ?? await ds.getRepository(core.TaxCategory).findOne({ where: {} });
            const product = await app.get(core.ProductService).create(ctx, {
                enabled: false,
                translations: [{ languageCode: 'en', name: PLACEHOLDER.name, slug: PLACEHOLDER.slug, description: 'Stands in for Shopware order lines whose product has no Vendure variant.' }],
            });
            const [variant] = await app.get(core.ProductVariantService).create(ctx, [{
                productId: product.id, sku: PLACEHOLDER.sku, price: 0, enabled: false, taxCategoryId: taxCategory.id, trackInventory: 'FALSE',
                translations: [{ languageCode: 'en', name: PLACEHOLDER.name }],
            }]);
            await bindings.set('placeholder', PLACEHOLDER.sku, 'variant', variant.id);
            c.created++;
        });

        await step('orders', async c => {
            const placeholderId = bindings.get('placeholder', PLACEHOLDER.sku, 'variant');
            const variantIds = new Set(model.orders.flatMap(o => o.lines.map(l => l.productSourceId ? bindings.get('product', l.productSourceId, 'variant') : placeholderId)).filter(Boolean));
            const variants = new Map((await ds.getRepository(core.ProductVariant).findByIds([...variantIds])).map(v => [String(v.id), v]));
            const taxZoneId = channel.defaultTaxZone?.id ?? channel.defaultTaxZoneId;
            for (const o of model.orders) {
                if (bindings.get('order', o.sourceId, 'order')) { c.skipped++; continue; }
                try {
                    const id = await ds.transaction(m => writeOrder(m, core, { o, channel, taxZoneId, variants, placeholderId, bindings, totalsFromInvoice }));
                    await bindings.set('order', o.sourceId, 'order', id);
                    c.created++;
                } catch (e) { fail('orders', o.sourceId, e, c); }
            }
        });
    } finally {
        await app.close();
    }
    const result = { startedAt, finishedAt: new Date().toISOString(), counts, timings, failures, totalsFromInvoice, bindings: bindings.size };
    log(`load-sales: ${totalsFromInvoice.length} orders store Shopware's invoice total instead of Vendure's calculation`);
    await writeJson(path.join(snapshotDir, 'load-sales-result.json'), result);
    log(`load-sales done: ${failures.length} failures, ${bindings.size} bindings`);
    return result;
}

const taxLine = (rate, description) => [{ description: `${rate}%${description ? ` ${description}` : ''}`, taxRate: rate }];

/**
 * Writes one order with its lines, surcharges, shipping line, payments, refund and fulfillment.
 * Totals are computed by Vendure's own entity getters, so the dashboard's line and order figures
 * agree; the compare stage measures how far they are from Shopware's invoice amounts.
 */
async function writeOrder(m, core, { o, channel, taxZoneId, variants, placeholderId, bindings, totalsFromInvoice }) {
    const customerId = o.customerSourceId ? bindings.get('customer', o.customerSourceId, 'customer') : undefined;
    if (o.customerSourceId && !customerId) throw new Error(`customer ${o.customerSourceId} is not bound`);
    if (!customerId) throw new Error('order without a migrated customer');
    const placedAt = new Date(`${o.orderPlacedAt}Z`);

    const lines = o.lines.map(l => {
        const variantId = l.productSourceId ? bindings.get('product', l.productSourceId, 'variant') : placeholderId;
        const variant = variants.get(String(variantId));
        if (!variant) throw new Error(`line ${l.sourceId}: variant ${variantId ?? l.productSourceId} not found`);
        return new core.OrderLine({
            productVariant: variant, taxCategory: { id: variant.taxCategoryId }, featuredAsset: variant.featuredAssetId ? { id: variant.featuredAssetId } : undefined,
            quantity: l.quantity, orderPlacedQuantity: l.quantity, initialListPrice: l.listPrice, listPrice: l.listPrice,
            listPriceIncludesTax: l.listPriceIncludesTax, adjustments: [], taxLines: taxLine(l.taxRate),
            customFields: { shopwareLineType: 'product', legacyLabel: l.label, legacyProductNumber: l.productNumber ?? null },
            createdAt: placedAt,
        });
    });
    const surcharges = o.surcharges.map(s => new core.Surcharge({
        description: s.description, sku: s.sku, listPrice: s.listPrice, listPriceIncludesTax: s.listPriceIncludesTax,
        taxLines: taxLine(s.taxRate), createdAt: placedAt,
    }));
    const shippingMethodId = o.shipping.methodSourceId ? bindings.get('shippingMethod', o.shipping.methodSourceId, 'shippingMethod') : undefined;
    const shippingLine = new core.ShippingLine({
        shippingMethodId: shippingMethodId ?? null, listPrice: o.shipping.listPrice, listPriceIncludesTax: o.shipping.listPriceIncludesTax,
        adjustments: [], taxLines: taxLine(o.shipping.taxRate), createdAt: placedAt,
    });

    // The configured strategy, as OrderCalculator uses it. Where its result misses Shopware's
    // invoice total, the invoice wins: it is what was paid, and Vendure compares payments with
    // totalWithTax on every later modification or refund.
    const calculated = core.getConfig().taxOptions.orderTaxCalculationStrategy
        .calculateOrderTotals({ lines, surcharges, shippingLines: [shippingLine] });
    const shipping = shippingLine.discountedPrice;
    const shippingWithTax = shippingLine.discountedPriceWithTax;
    const invoice = { subTotal: o.source.total - shipping, subTotalWithTax: o.source.totalWithTax - shippingWithTax };
    const fromInvoice = calculated.subTotal !== invoice.subTotal || calculated.subTotalWithTax !== invoice.subTotalWithTax;
    const { subTotal, subTotalWithTax } = fromInvoice ? invoice : calculated;
    if (fromInvoice) totalsFromInvoice.push({ code: o.code, calculated: [calculated.subTotalWithTax, calculated.subTotal], invoice: [invoice.subTotalWithTax, invoice.subTotal] });

    const order = await m.save(new core.Order({
        type: 'Regular', code: o.code, state: o.state, active: false, orderPlacedAt: placedAt,
        customer: { id: customerId }, currencyCode: o.currencyCode, couponCodes: o.couponCodes,
        shippingAddress: o.shippingAddress, billingAddress: o.billingAddress, channels: [channel], taxZoneId,
        subTotal, subTotalWithTax, shipping, shippingWithTax,
        customFields: { shopwareId: o.sourceId, shopwareStates: o.shopwareStates },
        createdAt: placedAt, updatedAt: placedAt,
    }));
    shippingLine.order = order;
    const savedShipping = await m.save(shippingLine);
    const savedLines = [];
    for (const l of lines) {
        l.order = order;
        l.shippingLine = savedShipping;
        savedLines.push(await m.save(l));
    }
    for (const s of surcharges) {
        s.order = order;
        await m.save(s);
    }
    let lastPayment;
    for (const p of o.payments) {
        lastPayment = await m.save(new core.Payment({
            method: p.method, amount: p.amount, state: p.state, transactionId: p.sourceId, order,
            metadata: { public: { shopwarePaymentMethod: p.methodName, shopwareState: p.shopwareState } },
            createdAt: new Date(`${p.createdAt}Z`),
        }));
    }
    if (o.refund) {
        await m.save(new core.Refund({
            items: 0, shipping: 0, adjustment: o.refund.amount, total: o.refund.amount, method: lastPayment.method,
            reason: 'Refunded in Shopware', state: 'Settled', transactionId: lastPayment.transactionId, payment: lastPayment,
            metadata: {}, createdAt: o.refund.createdAt ? new Date(`${o.refund.createdAt}Z`) : placedAt,
        }));
    }
    if (o.fulfillment) {
        const fulfillment = await m.save(new core.Fulfillment({
            state: o.fulfillment.state, method: o.fulfillment.method, trackingCode: o.fulfillment.trackingCode,
            handlerCode: 'manual-fulfillment', orders: [order],
            createdAt: o.fulfillment.createdAt ? new Date(`${o.fulfillment.createdAt}Z`) : placedAt,
        }));
        for (const l of savedLines) {
            await m.save(new core.FulfillmentLine({ fulfillment, orderLine: l, quantity: l.quantity }));
        }
    }
    return order.id;
}
