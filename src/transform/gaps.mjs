// What the migration does not carry over, with counts, for gaps.json and the verify report.
import { SHOPWARE } from '../config.mjs';
import { groupBy } from '../lib/util.mjs';

const FULL_VISIBILITY = 30; // ProductVisibilityDefinition::VISIBILITY_ALL

/**
 * @param {object} raw Snapshot tables (rules, product_price_summary, currencies, product_configurator_settings).
 * @param {object} built { families, collections, skippedLinks, redirects, unmatchedSeoUrls, problems, familyIssues, taxGaps, languageGaps, priceStats, categoryIndexGaps }.
 * @returns {object} The gaps.json content. Keys read by verify: rulePrices, currencies, visibility,
 *   categories, closeout, configurator, seo, notInSlice. Never throws.
 */
export function buildGaps(raw, { families, collections, skippedLinks, redirects, unmatchedSeoUrls, problems, familyIssues, taxGaps, languageGaps, priceStats, categoryIndexGaps }) {
    const allOffers = families.flatMap(f => f.offers);
    const ruleById = new Map(raw.rules.map(r => [r.id, r]));
    const isoByKey = new Map(raw.currencies.map(c => [`c${c.id}`, c.iso_code]));
    const configuratorByProduct = groupBy(raw.product_configurator_settings, 'product_id');
    const configuratorUnused = families.filter(f => f.kind === 'family').reduce((n, f) => {
        const used = new Set(f.offers.flatMap(o => o.optionSourceIds));
        return n + (configuratorByProduct.get(f.sourceId) ?? []).filter(s => !used.has(s.option_id)).length;
    }, 0);
    return {
        ...taxGaps,
        languages: languageGaps,
        rulePrices: {
            verdict: 'not migrated; solution sketched as price strategies in sketches/shopware-rule-prices (never run)',
            rows: raw.product_price_summary.reduce((n, r) => n + Number(r.tiers), 0),
            rules: [...groupBy(raw.product_price_summary, 'rule_id').entries()].map(([ruleId, rows]) => ({
                name: ruleById.get(ruleId)?.name,
                priority: ruleById.get(ruleId)?.priority,
                products: rows.length,
                tiers: rows.reduce((n, r) => n + Number(r.tiers), 0),
            })),
        },
        currencies: {
            verdict: 'only the default-currency price is migrated; explicit prices a product stores for other currencies are not, nor the factor-based prices Shopware derives at runtime for the rest',
            notMigrated: raw.currencies.filter(c => c.id !== SHOPWARE.CURRENCY).map(c => `${c.iso_code} (factor ${c.factor})`),
            offersWithExplicitPricesInOtherCurrencies: priceStats.offersWithOtherCurrencies,
            explicitPricesByCurrency: Object.fromEntries(Object.entries(priceStats.otherCurrencyKeys).map(([k, n]) => [isoByKey.get(k) ?? k, n])),
        },
        listPrices: {
            offers: priceStats.offersWithListPrice,
            verdict: 'Shopware list prices (the struck-through "before" price) are not migrated; Vendure has no list price field',
        },
        prices: {
            offersWithoutConvertibleGross: priceStats.grossNotConvertible,
            offersWithoutConvertibleNet: priceStats.netNotConvertible,
            grossRoundedFromLinked: priceStats.grossRoundedFromLinked,
            netRoundedFromLinked: priceStats.netRoundedFromLinked,
            verdict: 'both prices are kept when convertible to minor units; a sub-cent price Shopware derived from the other one (linked: true) is rounded half-up to the currency decimals and counted in *RoundedFromLinked; an unlinked sub-cent price is not rounded, and only the one load sends (gross or net, see pricesIncludeTax) can refuse an offer, see problems.refusedOffers',
        },
        visibility: {
            verdict: 'Vendure has channel membership, not per-channel visibility levels',
            offersNotFullyVisibleInStorefront: allOffers.filter(o => !o.storefrontVisibility.includes(FULL_VISIBILITY)).length,
        },
        categories: {
            productStreamCategories: collections.filter(c => c.assignment === 'product_stream').length,
            linkCategoriesSkipped: skippedLinks.length,
            hiddenInNavigation: collections.filter(c => c.hiddenInNavigation).length,
            verdict: 'dynamic (product stream) membership is not migrated; those collections are created empty',
        },
        categoryIndex: categoryIndexGaps,
        closeout: {
            offers: allOffers.filter(o => o.isCloseout).length,
            verdict: 'is_closeout (do not sell when out of stock) maps to Vendure out-of-stock settings; not configured in this slice',
        },
        configurator: {
            settingsWithPriceOverride: raw.product_configurator_settings.filter(s => Number(s.has_price_override)).length,
            settingsForOptionsNoVariantUses: configuratorUnused,
        },
        seo: {
            productsWithSeoUrl: new Set(redirects.filter(r => r.type === 'product').map(r => r.sourceId)).size,
            productsTotal: families.length,
            variantsWithSeoUrl: new Set(redirects.filter(r => r.type === 'variant').map(r => r.sourceId)).size,
            categoriesWithSeoUrl: new Set(redirects.filter(r => r.type === 'category').map(r => r.sourceId)).size,
            redirects: redirects.length,
            unmatchedSeoUrls,
            verdict: 'every storefront SEO URL becomes a redirect (variants to their product, languages without own slug to the default-language slug); products without a Shopware SEO URL get a slug from their name; slugs are made unique per language; unmatchedSeoUrls counts SEO URLs whose product or category is not migrated',
        },
        notInSlice: ['customers', 'orders', 'CMS layouts (every category references one)', 'category media', 'manufacturer media and links', 'property option colours and media', 'cross-selling', 'product reviews', 'purchase and reference units', 'dimensions and weight'],
        problems: { ...problems, familyIssues },
    };
}
