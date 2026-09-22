// Stage 5: write the intermediate model into Vendure through the Admin API.
// Every create is bound (source -> target id) before moving on; anything already bound is
// skipped, so a re-run after a failure continues instead of duplicating.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bindings } from './lib/bindings.mjs';
import { log, slugify, uniqueCoder, writeJson, readJson } from './lib/util.mjs';
import { unwrap, VendureClient } from './lib/vendure-client.mjs';

const ASSET_CONCURRENCY = 4;
const FAMILY_CONCURRENCY = 4;

async function pool(items, size, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

/**
 * Load journals of every snapshot, oldest first, with the current one last. `all` starts a new
 * snapshot per run, so the bindings a crashed run did not flush sit in an older snapshot.
 */
async function loadJournals(outDir, snapshotDir) {
    const dir = path.join(outDir, 'snapshots');
    const others = (await fs.readdir(dir).catch(() => []))
        .sort()
        .map(name => path.join(dir, name))
        .filter(d => path.resolve(d) !== path.resolve(snapshotDir));
    return [...others, snapshotDir].map(d => path.join(d, 'load-journal.ndjson'));
}

export async function load(config, snapshotDir) {
    const model = await readJson(path.join(snapshotDir, 'model.json'));
    const client = new VendureClient(config.target);
    await client.login();
    const bindings = await new Bindings(
        path.join(config.outDir, 'bindings.json'),
        path.join(snapshotDir, 'load-journal.ndjson'),
        await loadJournals(config.outDir, snapshotDir),
    ).load();
    const lang = model.defaultLanguageCode;
    const failures = [];
    const timings = {};
    const counts = {};
    const fail = (step, sourceId, err) => {
        failures.push({ step, sourceId, message: err.message, graphql: err.graphqlErrors?.map(e => e.message) });
        log(`FAIL ${step} ${sourceId}: ${err.message}`);
    };
    const step = async (name, fn) => {
        const t0 = Date.now();
        counts[name] = { created: 0, skipped: 0 };
        await fn(counts[name]);
        await bindings.flush();
        timings[name] = Date.now() - t0;
        log(`load ${name}: created ${counts[name].created}, skipped ${counts[name].skipped} (${timings[name]} ms)`);
    };

    /** Translation list with the default language guaranteed, as Vendure requires. */
    const translations = (byLang, extra = () => ({})) => {
        const codes = Object.keys(byLang);
        const list = codes.map(code => ({ languageCode: code, name: byLang[code], ...extra(code) }));
        if (!codes.includes(lang)) {
            const fallback = codes[0];
            list.push({ languageCode: lang, name: fallback ? byLang[fallback] : '(unnamed)', ...extra(fallback ?? lang) });
        }
        return list;
    };

    // ----- 1. global settings and countries ---------------------------------------------
    await step('settings', async c => {
        const r = await client.gql(
            `mutation($input: UpdateGlobalSettingsInput!) { updateGlobalSettings(input: $input) {
                ... on GlobalSettings { availableLanguages } ... on ErrorResult { errorCode message } } }`,
            { input: { availableLanguages: model.languageCodes } },
        );
        unwrap(r.updateGlobalSettings, 'updateGlobalSettings');
        c.created++;
    });

    await step('countries', async c => {
        for (const country of model.countries) {
            if (bindings.get('country', country.sourceId, 'country')) { c.skipped++; continue; }
            try {
                const names = Object.keys(country.names).length ? country.names : { [lang]: country.code };
                const r = await client.gql(
                    `mutation($input: CreateCountryInput!) { createCountry(input: $input) { id } }`,
                    { input: { code: country.code, enabled: country.enabled, translations: translations(names) } },
                );
                await bindings.set('country', country.sourceId, 'country', r.createCountry.id);
                c.created++;
            } catch (e) { fail('countries', country.code, e); }
        }
    });
    const countryId = code => bindings.get('country', model.countries.find(x => x.code === code).sourceId, 'country');

    // ----- 2. zones, tax categories, tax rates ---------------------------------------------
    await step('zones', async c => {
        const all = [
            ...model.taxZones.map(z => ({ key: `tax:${z.key}`, name: z.name, codes: z.countryCodes })),
            { key: 'shipping:storefront', name: 'Storefront countries', codes: model.countries.filter(x => x.enabled).map(x => x.code) },
        ];
        for (const z of all) {
            if (bindings.get('zone', z.key, 'zone')) { c.skipped++; continue; }
            try {
                const r = await client.gql(
                    `mutation($input: CreateZoneInput!) { createZone(input: $input) { id } }`,
                    { input: { name: z.name, memberIds: z.codes.map(countryId).filter(Boolean) } },
                );
                await bindings.set('zone', z.key, 'zone', r.createZone.id);
                c.created++;
            } catch (e) { fail('zones', z.key, e); }
        }
    });

    await step('taxCategories', async c => {
        for (const t of model.taxCategories) {
            if (bindings.get('tax', t.sourceId, 'taxCategory')) { c.skipped++; continue; }
            try {
                const r = await client.gql(
                    `mutation($input: CreateTaxCategoryInput!) { createTaxCategory(input: $input) { id } }`,
                    { input: { name: t.name, isDefault: t.isDefault } },
                );
                await bindings.set('tax', t.sourceId, 'taxCategory', r.createTaxCategory.id);
                c.created++;
            } catch (e) { fail('taxCategories', t.name, e); }
        }
    });

    await step('taxRates', async c => {
        for (const z of model.taxZones) {
            for (const t of model.taxCategories) {
                const key = `${z.key}|${t.sourceId}`;
                if (bindings.get('taxRate', key, 'taxRate')) { c.skipped++; continue; }
                try {
                    const r = await client.gql(
                        `mutation($input: CreateTaxRateInput!) { createTaxRate(input: $input) { id } }`,
                        {
                            input: {
                                name: `${t.name} ${z.rates[t.sourceId]}% (${z.key})`,
                                enabled: true,
                                value: z.rates[t.sourceId],
                                categoryId: bindings.get('tax', t.sourceId, 'taxCategory'),
                                zoneId: bindings.get('zone', `tax:${z.key}`, 'zone'),
                            },
                        },
                    );
                    await bindings.set('taxRate', key, 'taxRate', r.createTaxRate.id);
                    c.created++;
                } catch (e) { fail('taxRates', key, e); }
            }
        }
    });

    // ----- 3. channel -----------------------------------------------------------------------
    await step('channel', async c => {
        const { activeChannel } = await client.gql(`{ activeChannel { id } }`);
        const defaultZone = model.taxZones.find(z => z.isDefault);
        const r = await client.gql(
            `mutation($input: UpdateChannelInput!) { updateChannel(input: $input) {
                ... on Channel { id } ... on ErrorResult { errorCode message } } }`,
            {
                input: {
                    id: activeChannel.id,
                    defaultLanguageCode: lang,
                    availableLanguageCodes: model.languageCodes,
                    defaultCurrencyCode: model.currencyCode,
                    availableCurrencyCodes: [model.currencyCode],
                    pricesIncludeTax: model.pricesIncludeTax,
                    defaultTaxZoneId: bindings.get('zone', `tax:${defaultZone.key}`, 'zone'),
                    defaultShippingZoneId: bindings.get('zone', 'shipping:storefront', 'zone'),
                },
            },
        );
        unwrap(r.updateChannel, 'updateChannel');
        c.created++;
    });

    // ----- 4. assets ----------------------------------------------------------------------
    await step('assets', async c => {
        const todo = model.assets.filter(a => !a.private);
        c.skippedPrivate = model.assets.length - todo.length;
        await pool(todo, ASSET_CONCURRENCY, async asset => {
            if (bindings.get('media', asset.sourceId, 'asset')) { c.skipped++; return; }
            try {
                const res = await fetch(asset.url);
                if (!res.ok) throw new Error(`HTTP ${res.status} for ${asset.url}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const id = await client.uploadAsset(asset.fileName, bytes, asset.mimeType);
                await bindings.set('media', asset.sourceId, 'asset', id);
                c.created++;
            } catch (e) { fail('assets', asset.sourceId, e); }
        });
    });
    const assetId = mediaId => (mediaId ? bindings.get('media', mediaId, 'asset') : undefined);

    // ----- 5. facets ----------------------------------------------------------------------
    await step('facets', async c => {
        for (const f of model.facets) {
            if (bindings.get('facet', f.sourceId, 'facet')) { c.skipped++; continue; }
            try {
                const r = await client.gql(
                    `mutation($input: CreateFacetInput!) { createFacet(input: $input) { id values { id code } } }`,
                    {
                        input: {
                            code: f.code,
                            isPrivate: false,
                            translations: translations(f.names),
                            values: f.values.map(v => ({ code: v.code, translations: translations(v.names) })),
                        },
                    },
                );
                await bindings.set('facet', f.sourceId, 'facet', r.createFacet.id);
                const byCode = new Map(r.createFacet.values.map(v => [v.code, v.id]));
                for (const v of f.values) await bindings.set(f.kind === 'manufacturer' ? 'manufacturer' : 'propertyOption', v.sourceId, 'facetValue', byCode.get(v.code));
                c.created++;
            } catch (e) { fail('facets', f.code, e); }
        }
    });
    const propertyValue = optionId => bindings.get('propertyOption', optionId, 'facetValue');
    const manufacturerValue = id => (id ? bindings.get('manufacturer', id, 'facetValue') : undefined);

    // ----- 6. products, option groups, variants --------------------------------------------
    await step('products', async c => {
        c.variantsCreated = 0;
        c.variantsSkipped = 0;
        await pool(model.families, FAMILY_CONCURRENCY, async family => {
            try {
                let productId = bindings.get('product', family.sourceId, 'product');
                if (!productId) {
                    const r = await client.gql(
                        `mutation($input: CreateProductInput!) { createProduct(input: $input) { id } }`,
                        {
                            input: {
                                enabled: family.enabled,
                                translations: translations(family.names, code => ({
                                    slug: family.slugs[code] ?? slugify(`${family.names[code] ?? family.sku}-${family.sku}`),
                                    description: family.descriptions[code] ?? '',
                                })),
                                facetValueIds: [
                                    ...family.propertyOptionIds.map(propertyValue),
                                    manufacturerValue(family.manufacturerSourceId),
                                ].filter(Boolean),
                                assetIds: family.mediaSourceIds.map(assetId).filter(Boolean),
                                featuredAssetId: assetId(family.coverMediaSourceId),
                            },
                        },
                    );
                    productId = r.createProduct.id;
                    await bindings.set('product', family.sourceId, 'product', productId);
                    c.created++;
                } else c.skipped++;

                // Option groups, one set per product, codes unique within the family.
                const groupCodes = uniqueCoder();
                for (const group of family.optionGroups) {
                    const groupKey = `${family.sourceId}|${group.sourceId}`;
                    if (bindings.get('optionGroup', groupKey, 'optionGroup')) continue;
                    const optionCodes = uniqueCoder();
                    const options = group.optionSourceIds.map(optionId => {
                        const facet = model.facets.find(f => f.sourceId === group.sourceId);
                        const value = facet?.values.find(v => v.sourceId === optionId);
                        return { optionId, code: optionCodes(value?.code ?? slugify(optionId)), names: value?.names ?? { [lang]: optionId } };
                    });
                    const r = await client.gql(
                        `mutation($input: CreateProductOptionGroupInput!) { createProductOptionGroup(input: $input) { id options { id code } } }`,
                        {
                            input: {
                                code: groupCodes(slugify(`${family.sku}-${group.names[lang] ?? group.sourceId}`)),
                                translations: translations(group.names),
                                options: options.map(o => ({ code: o.code, translations: translations(o.names) })),
                            },
                        },
                    );
                    const byCode = new Map(r.createProductOptionGroup.options.map(o => [o.code, o.id]));
                    for (const o of options) await bindings.set('productOption', `${family.sourceId}|${o.optionId}`, 'option', byCode.get(o.code));
                    await client.gql(
                        `mutation($p: ID!, $g: ID!) { addOptionGroupToProduct(productId: $p, optionGroupId: $g) { id } }`,
                        { p: productId, g: r.createProductOptionGroup.id },
                    );
                    await bindings.set('optionGroup', groupKey, 'optionGroup', r.createProductOptionGroup.id);
                }

                // Variants, one batch per family.
                const pending = family.offers.filter(o => !bindings.get('product', o.sourceId, 'variant'));
                c.variantsSkipped += family.offers.length - pending.length;
                if (!pending.length) return;
                const r = await client.gql(
                    `mutation($input: [CreateProductVariantInput!]!) { createProductVariants(input: $input) { id sku } }`,
                    {
                        input: pending.map(o => ({
                            productId,
                            sku: o.sku,
                            enabled: o.enabled,
                            price: o.priceGrossMinor,
                            taxCategoryId: bindings.get('tax', o.taxSourceId, 'taxCategory'),
                            stockOnHand: o.stockOnHand,
                            optionIds: o.optionSourceIds.map(id => bindings.get('productOption', `${family.sourceId}|${id}`, 'option')),
                            facetValueIds: [
                                ...(family.kind === 'family' ? o.ownPropertyOptionIds.map(propertyValue) : []),
                                o.manufacturerSourceId !== family.manufacturerSourceId ? manufacturerValue(o.manufacturerSourceId) : undefined,
                            ].filter(Boolean),
                            assetIds: o.mediaSourceIds.map(assetId).filter(Boolean),
                            featuredAssetId: assetId(o.coverMediaSourceId),
                            translations: translations(Object.keys(o.names).length ? o.names : family.names),
                        })),
                    },
                );
                const bySku = new Map(r.createProductVariants.filter(Boolean).map(v => [v.sku, v.id]));
                for (const o of pending) {
                    const id = bySku.get(o.sku);
                    if (id) { await bindings.set('product', o.sourceId, 'variant', id); c.variantsCreated++; }
                    else fail('variants', o.sku, new Error('variant missing from createProductVariants result'));
                }
            } catch (e) { fail('products', family.sku, e); }
        });
    });

    // ----- 7. collections (parents first; model order is tree order) ------------------------
    await step('collections', async c => {
        for (const col of model.collections) {
            if (bindings.get('category', col.sourceId, 'collection')) { c.skipped++; continue; }
            try {
                const variantIds = col.offerSourceIds.map(id => bindings.get('product', id, 'variant')).filter(Boolean);
                if (variantIds.length !== col.offerSourceIds.length) {
                    c.membersMissing = (c.membersMissing ?? 0) + (col.offerSourceIds.length - variantIds.length);
                }
                const r = await client.gql(
                    `mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }`,
                    {
                        input: {
                            parentId: col.parentSourceId ? bindings.get('category', col.parentSourceId, 'collection') : undefined,
                            isPrivate: col.isPrivate,
                            inheritFilters: false,
                            filters: variantIds.length
                                ? [{ code: 'variant-id-filter', arguments: [
                                    { name: 'variantIds', value: JSON.stringify(variantIds) },
                                    { name: 'combineWithAnd', value: 'true' },
                                ] }]
                                : [],
                            translations: translations(col.names, code => ({
                                slug: col.slugs[code] ?? slugify(`${col.names[code] ?? col.sourceId}`),
                                description: col.descriptions[code] ?? '',
                            })),
                        },
                    },
                );
                await bindings.set('category', col.sourceId, 'collection', r.createCollection.id);
                c.created++;
            } catch (e) { fail('collections', col.sourceId, e); }
        }
    });

    const result = { finishedAt: new Date().toISOString(), counts, timings, failures, bindings: bindings.size };
    await writeJson(path.join(snapshotDir, 'load-result.json'), result);
    log(`load done: ${failures.length} failures, ${bindings.size} bindings`);
    return result;
}
