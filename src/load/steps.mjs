// The load steps, in dependency order. Each step creates what is not bound yet, binds every
// create right after Vendure returns its id, and records a failure per item instead of stopping.
// Only settings and channel throw: every later object depends on the channel's languages,
// currency and tax mode, so creating them without would store wrong prices.
import { request } from '../lib/http.mjs';
import { slugify } from '../lib/util.mjs';
import { unwrap } from '../lib/vendure-client.mjs';
import { bindChildren, pool } from './context.mjs';
import { loadProducts } from './products.mjs';

const ASSET_CONCURRENCY = 4;

/** Sets the available languages. Throws on failure. */
export async function loadSettings({ client, model }, c) {
    const r = await client.gql(
        `mutation($input: UpdateGlobalSettingsInput!) { updateGlobalSettings(input: $input) {
            ... on GlobalSettings { availableLanguages } ... on ErrorResult { errorCode message } } }`,
        { input: { availableLanguages: model.languageCodes } },
    );
    unwrap(r.updateGlobalSettings, 'updateGlobalSettings');
    c.created++;
}

export async function loadCountries({ client, model, bindings, lang, translations, fail }, c) {
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
}

export async function loadZones({ client, model, bindings, ref, fail }, c) {
    const all = [
        ...model.taxZones.map(z => ({ key: `tax:${z.key}`, name: z.name, codes: z.countryCodes })),
        { key: 'shipping:storefront', name: 'Storefront countries', codes: model.countries.filter(x => x.enabled).map(x => x.code) },
    ];
    for (const z of all) {
        if (bindings.get('zone', z.key, 'zone')) { c.skipped++; continue; }
        try {
            const r = await client.gql(
                `mutation($input: CreateZoneInput!) { createZone(input: $input) { id } }`,
                { input: { name: z.name, memberIds: z.codes.map(ref.country) } },
            );
            await bindings.set('zone', z.key, 'zone', r.createZone.id);
            c.created++;
        } catch (e) { fail('zones', z.key, e); }
    }
}

export async function loadTaxCategories({ client, model, bindings, fail }, c) {
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
}

export async function loadTaxRates({ client, model, bindings, ref, fail }, c) {
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
                            value: z.rates[t.sourceId] ?? null,
                            categoryId: ref.taxCategory(t.sourceId),
                            zoneId: ref.zone(`tax:${z.key}`),
                        },
                    },
                );
                await bindings.set('taxRate', key, 'taxRate', r.createTaxRate.id);
                c.created++;
            } catch (e) { fail('taxRates', key, e); }
        }
    }
}

/** Sets languages, currency, tax mode and default zones of the active channel. Throws on failure. */
export async function loadChannel({ client, model, lang, ref }, c) {
    const { activeChannel } = await client.gql(`{ activeChannel { id } }`);
    const defaultZone = model.taxZones.find(z => z.isDefault);
    if (!defaultZone) throw new Error('model has no default tax zone');
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
                defaultTaxZoneId: ref.zone(`tax:${defaultZone.key}`),
                defaultShippingZoneId: ref.zone('shipping:storefront'),
            },
        },
    );
    unwrap(r.updateChannel, 'updateChannel');
    c.created++;
}

export async function loadAssets({ client, model, bindings, http, fail }, c) {
    const todo = model.assets.filter(a => !a.private);
    c.skippedPrivate = model.assets.length - todo.length;
    await pool(todo, ASSET_CONCURRENCY, async asset => {
        if (bindings.get('media', asset.sourceId, 'asset')) { c.skipped++; return; }
        try {
            // The download is a read and may retry; the upload creates the asset and does not.
            const { data: bytes } = await request(asset.url, { ...http, as: 'bytes', retry: true });
            const id = await client.uploadAsset(asset.fileName, bytes, asset.mimeType);
            await bindings.set('media', asset.sourceId, 'asset', id);
            c.created++;
        } catch (e) { fail('assets', asset.sourceId, e); }
    });
}

/**
 * Facets with their values. A facet whose values are only partly bound (a value code Vendure
 * changed, or a crash between binds) is completed on the next run: the values in Vendure are
 * read back and matched, and only values Vendure does not have are created.
 */
export async function loadFacets(ctx, c) {
    const { client, model, bindings, translations, fail } = ctx;
    c.completed = 0;
    for (const f of model.facets) {
        const role = f.kind === 'manufacturer' ? 'manufacturer' : 'propertyOption';
        const boundValue = v => bindings.get(role, v.sourceId, 'facetValue');
        const unbound = f.values.filter(v => !boundValue(v));
        let facetId = bindings.get('facet', f.sourceId, 'facet');
        if (facetId && !unbound.length) { c.skipped++; continue; }
        try {
            let existing;
            if (!facetId) {
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
                facetId = r.createFacet.id;
                await bindings.set('facet', f.sourceId, 'facet', facetId);
                existing = r.createFacet.values;
                c.created++;
            } else {
                const r = await client.gql(`query($id: ID!) { facet(id: $id) { values { id code } } }`, { id: facetId });
                if (!r.facet) throw new Error(`facet ${facetId} is bound but not in Vendure`);
                const taken = new Set(f.values.map(boundValue).filter(id => id !== undefined));
                existing = r.facet.values.filter(v => !taken.has(String(v.id)));
                c.completed++;
            }
            await bindChildren(
                unbound.map(v => ({ code: v.code, value: v, bind: id => bindings.set(role, v.sourceId, 'facetValue', id) })),
                existing,
                async items => (await client.gql(
                    `mutation($input: [CreateFacetValueInput!]!) { createFacetValues(input: $input) { id code } }`,
                    { input: items.map(({ value }) => ({ facetId, code: value.code, translations: translations(value.names) })) },
                )).createFacetValues,
                `facet ${f.code}`,
            );
        } catch (e) { fail('facets', f.code, e); }
    }
}

export { loadProducts };

/**
 * Collections, parents first (model order is tree order). Membership is the model's list of
 * offers; offers load refuses to create (no price or tax) are left out and counted, any other
 * missing variant holds the collection back until a later run has created it.
 */
export async function loadCollections({ client, model, bindings, ref, isCreatable, translations, fail }, c) {
    c.membersExcluded = 0;
    for (const col of model.collections) {
        if (bindings.get('category', col.sourceId, 'collection')) { c.skipped++; continue; }
        try {
            const members = [...new Set(col.offerSourceIds)].filter(isCreatable);
            const variantIds = members.map(ref.variant);
            const r = await client.gql(
                `mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }`,
                {
                    input: {
                        parentId: col.parentSourceId ? ref.collection(col.parentSourceId) : undefined,
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
            c.membersExcluded += new Set(col.offerSourceIds).size - members.length;
            c.created++;
        } catch (e) { fail('collections', col.sourceId, e); }
    }
}

/** Step name, function, and whether a failure stops the load. */
export const STEPS = [
    ['settings', loadSettings, true],
    ['countries', loadCountries],
    ['zones', loadZones],
    ['taxCategories', loadTaxCategories],
    ['taxRates', loadTaxRates],
    ['channel', loadChannel, true],
    ['assets', loadAssets],
    ['facets', loadFacets],
    ['products', loadProducts],
    ['collections', loadCollections],
];
