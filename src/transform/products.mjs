// Shopware products -> product families (Vendure Products) with their offers (ProductVariants).
import { byLangMap, inherit, inheritRows } from '../lib/resolve.mjs';
import { groupBy, slugify } from '../lib/util.mjs';
import { resolvePrice } from './prices.mjs';

const byPosition = (a, b) => a.position - b.position;

/**
 * Lookup tables over the product tables of a snapshot. Pure; the raw arrays are not modified.
 * @param {object} raw Snapshot tables.
 * @param {{ id: string }} storefront The migrated sales channel.
 * @returns {object} Maps keyed by product id (and a few by option or product_media id). Never throws.
 */
export function indexProducts(raw, storefront) {
    return {
        childrenOf: groupBy(raw.products.filter(p => p.parent_id), 'parent_id'),
        translationsOf: groupBy(raw.product_translations, 'product_id'),
        optionsOf: groupBy(raw.product_options, 'product_id'),
        propertiesOf: groupBy(raw.product_properties, 'product_id'),
        categoriesOf: groupBy(raw.product_categories, 'product_id'),
        mediaOf: groupBy(raw.product_media, 'product_id'),
        productMediaById: new Map(raw.product_media.map(pm => [pm.id, pm])),
        visibilityOf: groupBy(raw.product_visibilities.filter(v => v.sales_channel_id === storefront.id), 'product_id'),
        groupNames: groupBy(raw.property_group_translations, 'group_id'),
        optionNames: groupBy(raw.property_group_option_translations, 'option_id'),
        optionById: new Map(raw.property_group_options.map(o => [o.id, o])),
    };
}

/**
 * Effective values of one sellable product row (a variant, or a product without variants).
 * @param {object} row The product row.
 * @param {object|null} parent Its parent row, or null for a top-level product.
 * @param {object} idx Output of indexProducts.
 * @param {{ currencyId: string, decimals: number, pricesIncludeTax: boolean }} pricing See resolvePrice.
 * @returns {{ offer: object, from: Record<string, string>, problems: Array<{ kind: string, entry: unknown }>, price: object }}
 *   `offer` has no `names`; the caller adds them. `from` records own/parent/none per inherited
 *   field; `price` is the resolvePrice result.
 * @throws Never; an unreadable price is reported as a problem.
 */
export function resolveOffer(row, parent, idx, pricing) {
    const price = inherit(row, parent, 'price');
    const tax = inherit(row, parent, 'tax_id');
    const manufacturer = inherit(row, parent, 'manufacturer_id');
    const active = inherit(row, parent, 'active');
    const categories = inheritRows(idx.categoriesOf, row, parent);
    const properties = inheritRows(idx.propertiesOf, row, parent);
    const problems = [];

    const prices = resolvePrice(price.value, pricing);
    const priceProblem = prices.problem;
    if (priceProblem?.kind === 'subCentPrice' || priceProblem?.kind === 'unconvertiblePrice') {
        problems.push({ kind: priceProblem.kind, entry: { sku: row.product_number, field: priceProblem.field, value: priceProblem.value, reason: priceProblem.reason } });
    } else if (priceProblem) {
        problems.push({ kind: priceProblem.kind, entry: row.product_number });
    }
    if (!tax.value) problems.push({ kind: 'untaxed', entry: row.product_number });
    const refusalReasons = [priceProblem?.reason, tax.value ? null : 'no tax after inheritance'].filter(Boolean);

    const ownMedia = (idx.mediaOf.get(row.id) ?? []).toSorted(byPosition);
    const cover = row.cover_product_media_id ? idx.productMediaById.get(row.cover_product_media_id) : undefined;

    return {
        offer: {
            sourceId: row.id,
            sku: row.product_number,
            enabled: Boolean(active.value),
            priceGrossMinor: prices.priceGrossMinor,
            priceNetMinor: prices.priceNetMinor,
            taxSourceId: tax.value,
            manufacturerSourceId: manufacturer.value,
            stockOnHand: Number(row.stock),
            isCloseout: Boolean(inherit(row, parent, 'is_closeout').value),
            optionSourceIds: (idx.optionsOf.get(row.id) ?? []).map(o => o.option_id),
            ownPropertyOptionIds: (idx.propertiesOf.get(row.id) ?? []).map(p => p.option_id),
            effectiveCategoryIds: categories.rows.map(c => c.category_id),
            mediaSourceIds: ownMedia.map(m => m.media_id),
            coverMediaSourceId: cover?.media_id ?? null,
            // visibilities is an inherited association, like categories and properties.
            storefrontVisibility: inheritRows(idx.visibilityOf, row, parent).rows.map(v => v.visibility),
        },
        from: {
            price: price.from,
            tax: tax.from,
            manufacturer: manufacturer.from,
            active: active.from,
            categories: categories.from,
            properties: properties.from,
            media: 'own',
        },
        problems: refusalReasons.length
            ? [...problems, { kind: 'refusedOffers', entry: { sku: row.product_number, sourceId: row.id, reasons: refusalReasons } }]
            : problems,
        price: prices,
    };
}

/**
 * Variant names per language: the resolved name, with the option labels appended when the name
 * is inherited from the parent, so variants stay distinguishable in Vendure.
 * @param {object} resolvedNames Output of resolveTranslated for the variant (parent as fallback).
 * @param {string[]} optionSourceIds The variant's options.
 * @param {(optionId: string, code: string) => string} optionLabel
 * @param {(resolved: object) => Record<string, unknown>} authored Bound authoredOnly.
 * @returns {Record<string, string>} code -> name, only for languages authoredOnly keeps. Never throws.
 */
export function variantNames(resolvedNames, optionSourceIds, optionLabel, authored) {
    return Object.fromEntries(
        Object.keys(authored(resolvedNames)).map(code => {
            const r = resolvedNames[code];
            const suffix = r.owner === 'parent' && optionSourceIds.length
                ? ` ${optionSourceIds.map(o => optionLabel(o, code)).join(' / ')}`
                : '';
            return [code, `${r.value}${suffix}`];
        }),
    );
}

/**
 * Builds the families (Vendure Products) and their offers (ProductVariants).
 * @param {object} raw Snapshot tables.
 * @param {object} ctx { storefront, defaultLanguageCode, translated, authored, namesOf, productSlugOf, pricing }.
 * @returns {{
 *   families: object[],
 *   provenance: Record<string, number>,
 *   problems: Record<string, unknown[]>,
 *   priceStats: { offersWithListPrice: number, offersWithOtherCurrencies: number, otherCurrencyKeys: Record<string, number>, netNotConvertible: number, grossNotConvertible: number },
 *   optionUsage: { parentsWithOptionRows: number },
 *   familyIssues: Array<{ family: string, sku: string, issue: string }>,
 *   decisions: Array<{ topic: string, text: string }>,
 * }}
 * @throws Never on data problems; they are returned in `problems`.
 */
export function buildFamilies(raw, ctx) {
    const { defaultLanguageCode, translated, authored, namesOf, productSlugOf, pricing } = ctx;
    const idx = indexProducts(raw, ctx.storefront);
    const optionLabel = (optionId, code) => {
        const names = namesOf(idx.optionNames.get(optionId));
        return names[code] ?? names[defaultLanguageCode] ?? optionId;
    };

    const resolved = [];
    const families = raw.products.filter(p => !p.parent_id).map(row => {
        const children = idx.childrenOf.get(row.id) ?? [];
        const isFamily = children.length > 0;
        const ownTranslations = byLangMap(idx.translationsOf.get(row.id) ?? []);
        const names = authored(translated(ownTranslations, null, 'name'));
        const descriptions = authored(translated(ownTranslations, null, 'description'));
        const familyMedia = (idx.mediaOf.get(row.id) ?? []).toSorted(byPosition).map(m => m.media_id);
        const cover = row.cover_product_media_id ? idx.productMediaById.get(row.cover_product_media_id)?.media_id : null;

        const offers = isFamily
            ? children.map(child => {
                const r = resolveOffer(child, row, idx, pricing);
                resolved.push(r);
                const childNames = translated(byLangMap(idx.translationsOf.get(child.id) ?? []), ownTranslations, 'name');
                return { ...r.offer, names: variantNames(childNames, r.offer.optionSourceIds, optionLabel, authored) };
            })
            : [(() => {
                const r = resolveOffer(row, null, idx, pricing);
                resolved.push(r);
                return { ...r.offer, names };
            })()];

        return {
            sourceId: row.id,
            kind: isFamily ? 'family' : 'simple',
            sku: row.product_number,
            names,
            descriptions,
            slugs: Object.fromEntries(Object.keys(names).map(code => [code, productSlugOf(row.id, code, names[code])])),
            enabled: Boolean(row.active),
            propertyOptionIds: (idx.propertiesOf.get(row.id) ?? []).map(p => p.option_id),
            manufacturerSourceId: row.manufacturer_id,
            mediaSourceIds: familyMedia,
            coverMediaSourceId: cover ?? familyMedia[0] ?? null,
            optionGroups: isFamily ? optionGroupsOf(offers, idx, namesOf) : [],
            offers,
        };
    });

    const count = (field, value) => resolved.filter(r => r.from[field] === value).length;
    const provenance = {
        priceFromParent: count('price', 'parent'),
        taxFromParent: count('tax', 'parent'),
        manufacturerFromParent: count('manufacturer', 'parent'),
        activeFromParent: count('active', 'parent'),
        categoriesFromParent: count('categories', 'parent'),
        propertiesFromParent: count('properties', 'parent'),
        mediaFromParent: count('media', 'parent'),
    };
    const problemsOf = kind => resolved.flatMap(r => r.problems.filter(p => p.kind === kind).map(p => p.entry));
    const problems = {
        unpriced: problemsOf('unpriced'),
        untaxed: problemsOf('untaxed'),
        subCentPrice: problemsOf('subCentPrice'),
        nonDefaultCurrencyOnly: problemsOf('nonDefaultCurrencyOnly'),
        invalidPriceJson: problemsOf('invalidPriceJson'),
        unconvertiblePrice: problemsOf('unconvertiblePrice'),
        // Every offer load refuses: its chosen price (gross or net, by pricesIncludeTax) or its tax is missing.
        refusedOffers: problemsOf('refusedOffers'),
    };
    const otherCurrencyKeys = {};
    for (const key of resolved.flatMap(r => r.price.otherCurrencyKeys)) otherCurrencyKeys[key] = (otherCurrencyKeys[key] ?? 0) + 1;
    const priceStats = {
        offersWithListPrice: resolved.filter(r => r.price.hasListPrice).length,
        offersWithOtherCurrencies: resolved.filter(r => r.price.otherCurrencyKeys.length).length,
        otherCurrencyKeys,
        grossNotConvertible: resolved.filter(r => r.price.priceGrossMinor === null).length,
        netNotConvertible: resolved.filter(r => r.price.priceNetMinor === null).length,
    };

    return {
        families,
        provenance,
        problems,
        priceStats,
        optionUsage: { parentsWithOptionRows: raw.products.filter(p => !p.parent_id && (idx.optionsOf.get(p.id) ?? []).length).length },
        familyIssues: familyIssuesOf(families, idx),
        decisions: [
            { topic: 'variants', text: 'A Shopware parent with children becomes one Vendure Product; only the children become ProductVariants. The parent row itself is never turned into a buyable variant. A product without children becomes a Product with exactly one variant.' },
            { topic: 'variant names', text: 'Variants whose name is inherited from the parent get the option labels appended (e.g. "Hoodie Red / M"), because Vendure lists variants by name. Variants with their own name keep it unchanged.' },
            { topic: 'translations', text: 'Translated values are resolved in Shopware DAL order, language-major: for each language of the chain (requested, its parent language, the system language) first the variant\'s own translation, then the parent product\'s, then the next language. A translation is only written to Vendure when the value was authored in that language; otherwise Vendure falls back to the default language, which yields the same text Shopware shows.' },
            { topic: 'prices', text: `Every offer carries priceGrossMinor and priceNetMinor from the default-currency entry of Shopware's price JSON, in minor units with ${pricing.decimals} decimals (${pricing.decimalsSource === 'item_rounding' ? 'currency.item_rounding' : 'default, item_rounding has none'}). Load sends the gross price when the storefront customer group shows gross prices (pricesIncludeTax), else the net price; a value with more decimals than the currency is never rounded, it becomes null and the offer is listed in gaps.problems.refusedOffers.` },
            { topic: 'stock', text: 'stockOnHand is product.stock (physical). available_stock is not used; open orders are not migrated, so there is nothing to allocate against in Vendure yet.' },
        ],
    };
}

/** Option groups used by a family's variants, each with only the options actually used. */
function optionGroupsOf(offers, idx, namesOf) {
    const groups = new Map();
    for (const optionId of offers.flatMap(o => o.optionSourceIds)) {
        const groupId = idx.optionById.get(optionId)?.group_id;
        groups.set(groupId, new Set([...(groups.get(groupId) ?? []), optionId]));
    }
    return [...groups.entries()].map(([groupId, opts]) => ({
        sourceId: groupId,
        names: namesOf(idx.groupNames.get(groupId)),
        optionSourceIds: [...opts],
    }));
}

/** Consistency rules Vendure enforces on a product's variants. */
function familyIssuesOf(families, idx) {
    return families.filter(f => f.kind === 'family').flatMap(family => {
        const groupCount = family.optionGroups.length;
        const seen = new Set();
        return family.offers.flatMap(offer => {
            const issues = [];
            const perGroup = new Set(offer.optionSourceIds.map(o => idx.optionById.get(o)?.group_id));
            if (perGroup.size !== groupCount || offer.optionSourceIds.length !== groupCount) {
                issues.push({ family: family.sku, sku: offer.sku, issue: 'variant does not have exactly one option per option group' });
            }
            const combo = offer.optionSourceIds.toSorted().join('+');
            if (seen.has(combo)) issues.push({ family: family.sku, sku: offer.sku, issue: 'duplicate option combination' });
            seen.add(combo);
            return issues;
        });
    });
}

/**
 * Slug lookup for products: the Shopware SEO URL of the storefront when there is one, otherwise
 * the slugified name.
 * @param {Map<string, string>} seoPathByKey `${productId}|${code}` -> seo_path_info.
 * @returns {(productId: string, code: string, name: string) => string} Never throws.
 */
export function slugFromSeoOrName(seoPathByKey) {
    return (id, code, name) => {
        const seo = seoPathByKey.get(`${id}|${code}`);
        return seo ? slugify(seo) : slugify(name);
    };
}
