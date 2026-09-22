// Products, their option groups and their variants, one family at a time.
import { slugify, uniqueCoder } from '../lib/util.mjs';
import { bindChildren, channelPrice, offerProblem, pool } from './context.mjs';

const FAMILY_CONCURRENCY = 4;

/**
 * Creates every family's product, option groups and variants. A family whose product cannot be
 * created, or none of whose offers can, is skipped as a whole; a variant that cannot be created
 * is skipped on its own.
 */
export async function loadProducts(ctx, c) {
    c.variantsCreated = 0;
    c.variantsSkipped = 0;
    c.variantsFailed = 0;
    await pool(ctx.model.families, FAMILY_CONCURRENCY, async family => {
        // A product none of whose offers can be created would stay empty in Vendure.
        if (!ctx.bindings.get('product', family.sourceId, 'product') && family.offers.every(o => offerProblem(ctx.model, o))) {
            for (const o of family.offers) {
                c.variantsFailed++;
                ctx.fail('variants', o.sku, new Error(offerProblem(ctx.model, o)));
            }
            return;
        }
        try {
            const productId = await ensureProduct(ctx, c, family);
            await ensureOptionGroups(ctx, family, productId);
            await createVariants(ctx, c, family, productId);
        } catch (e) { ctx.fail('products', family.sku, e); }
    });
}

async function ensureProduct({ client, bindings, ref, translations }, c, family) {
    const bound = bindings.get('product', family.sourceId, 'product');
    if (bound) { c.skipped++; return bound; }
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
                    ...family.propertyOptionIds.map(ref.propertyValue),
                    ...(family.manufacturerSourceId ? [ref.manufacturerValue(family.manufacturerSourceId)] : []),
                ],
                assetIds: ref.assets(family.mediaSourceIds),
                featuredAssetId: ref.featuredAsset(family.coverMediaSourceId),
            },
        },
    );
    await bindings.set('product', family.sourceId, 'product', r.createProduct.id);
    c.created++;
    return r.createProduct.id;
}

/**
 * One option group per model group, created, completed and attached in three bound steps, so a
 * failure in any of them is retried on the next run without creating a second group.
 */
async function ensureOptionGroups(ctx, family, productId) {
    const { client, model, bindings, lang, translations } = ctx;
    // Codes are handed out for every group, bound or not, so a re-run gives a group the same code.
    const groupCodes = uniqueCoder();
    for (const group of family.optionGroups) {
        const groupKey = `${family.sourceId}|${group.sourceId}`;
        const groupCode = groupCodes(slugify(`${family.sku}-${group.names[lang] ?? group.sourceId}`));
        const optionCodes = uniqueCoder();
        const facet = model.facets.find(f => f.sourceId === group.sourceId);
        const options = group.optionSourceIds.map(optionId => {
            const value = facet?.values.find(v => v.sourceId === optionId);
            return { optionId, code: optionCodes(value?.code ?? slugify(optionId)), names: value?.names ?? { [lang]: optionId } };
        });
        const optionKey = o => `${family.sourceId}|${o.optionId}`;
        const unbound = options.filter(o => !bindings.get('productOption', optionKey(o), 'option'));

        let groupId = bindings.get('optionGroup', groupKey, 'optionGroup');
        let existing;
        if (!groupId) {
            const r = await client.gql(
                `mutation($input: CreateProductOptionGroupInput!) { createProductOptionGroup(input: $input) { id options { id code } } }`,
                {
                    input: {
                        code: groupCode,
                        translations: translations(group.names),
                        options: options.map(o => ({ code: o.code, translations: translations(o.names) })),
                    },
                },
            );
            groupId = r.createProductOptionGroup.id;
            await bindings.set('optionGroup', groupKey, 'optionGroup', groupId);
            existing = r.createProductOptionGroup.options;
        } else if (unbound.length) {
            const r = await client.gql(`query($id: ID!) { productOptionGroup(id: $id) { options { id code } } }`, { id: groupId });
            if (!r.productOptionGroup) throw new Error(`option group ${groupId} is bound but not in Vendure`);
            const taken = new Set(options.map(o => bindings.get('productOption', optionKey(o), 'option')).filter(id => id !== undefined));
            existing = r.productOptionGroup.options.filter(o => !taken.has(String(o.id)));
        }
        if (unbound.length) {
            await bindChildren(
                unbound.map(o => ({ code: o.code, option: o, bind: id => bindings.set('productOption', optionKey(o), 'option', id) })),
                existing,
                async items => {
                    const created = [];
                    for (const { option } of items) {
                        const r = await client.gql(
                            `mutation($input: CreateProductOptionInput!) { createProductOption(input: $input) { id code } }`,
                            { input: { productOptionGroupId: groupId, code: option.code, translations: translations(option.names) } },
                        );
                        created.push(r.createProductOption);
                    }
                    return created;
                },
                `option group ${groupCode}`,
            );
        }

        if (!bindings.get('optionGroup', groupKey, 'product')) {
            // A run that crashed after attaching left no binding; attaching twice is an error.
            const r = await client.gql(`query($id: ID!) { product(id: $id) { optionGroups { id } } }`, { id: productId });
            if (!r.product?.optionGroups.some(g => String(g.id) === String(groupId))) {
                await client.gql(
                    `mutation($p: ID!, $g: ID!) { addOptionGroupToProduct(productId: $p, optionGroupId: $g) { id } }`,
                    { p: productId, g: groupId },
                );
            }
            await bindings.set('optionGroup', groupKey, 'product', productId);
        }
    }
}

/** Input of one variant, or throws when the offer or one of its references cannot be sent. */
function variantInput({ model, ref, translations }, family, productId, o) {
    const problem = offerProblem(model, o);
    if (problem) throw new Error(problem);
    return {
        productId,
        sku: o.sku,
        enabled: o.enabled,
        price: channelPrice(model, o),
        taxCategoryId: ref.taxCategory(o.taxSourceId),
        stockOnHand: o.stockOnHand,
        optionIds: o.optionSourceIds.map(id => ref.option(family.sourceId, id)),
        facetValueIds: [
            ...(family.kind === 'family' ? o.ownPropertyOptionIds.map(ref.propertyValue) : []),
            ...(o.manufacturerSourceId && o.manufacturerSourceId !== family.manufacturerSourceId ? [ref.manufacturerValue(o.manufacturerSourceId)] : []),
        ],
        assetIds: ref.assets(o.mediaSourceIds),
        featuredAssetId: ref.featuredAsset(o.coverMediaSourceId),
        translations: translations(Object.keys(o.names).length ? o.names : family.names),
    };
}

/** Creates the family's unbound variants in one request; offers that cannot be sent are failed one by one. */
async function createVariants(ctx, c, family, productId) {
    const { client, bindings, fail } = ctx;
    const pending = family.offers.filter(o => !bindings.get('product', o.sourceId, 'variant'));
    c.variantsSkipped += family.offers.length - pending.length;
    const batch = [];
    for (const o of pending) {
        try {
            batch.push({ offer: o, input: variantInput(ctx, family, productId, o) });
        } catch (e) {
            c.variantsFailed++;
            fail('variants', o.sku, e);
        }
    }
    if (!batch.length) return;
    const r = await client.gql(
        `mutation($input: [CreateProductVariantInput!]!) { createProductVariants(input: $input) { id sku } }`,
        { input: batch.map(b => b.input) },
    );
    const bySku = new Map((r.createProductVariants ?? []).filter(v => v).map(v => [v.sku, v.id]));
    for (const { offer } of batch) {
        const id = bySku.get(offer.sku);
        if (id) { await bindings.set('product', offer.sourceId, 'variant', id); c.variantsCreated++; }
        else { c.variantsFailed++; fail('variants', offer.sku, new Error('variant missing from createProductVariants result')); }
    }
}
