// Stage 2 + 3: resolve Shopware's effective values (live version, inheritance, translation
// fallback) and build a target-independent intermediate model, plus decisions and gaps.
// Each section is a pure builder in src/transform/; this file reads the snapshot, runs them in
// dependency order and writes the results.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SHOPWARE } from './config.mjs';
import { readSnapshot } from './lib/snapshot.mjs';
import { log, writeJson } from './lib/util.mjs';
import { buildAssets } from './transform/assets.mjs';
import { buildCollections, categoryIndexGaps, offersByCategory } from './transform/collections.mjs';
import { buildFacets } from './transform/facets.mjs';
import { buildGaps } from './transform/gaps.mjs';
import { buildLanguages, languageGaps } from './transform/languages.mjs';
import { currencyDecimals } from './transform/prices.mjs';
import { buildFamilies } from './transform/products.mjs';
import { buildRedirects, redirectsCsv, seoPaths } from './transform/redirects.mjs';
import { slugFromSeoOrName, uniqueSlugsPerLanguage } from './transform/slugs.mjs';
import { buildCountries, buildTax, pickStorefront } from './transform/tax.mjs';

/**
 * Builds the model from raw snapshot tables. Pure: no I/O, the input is not modified.
 * @param {object} raw Snapshot tables keyed by file name (raw/<name>.json).
 * @param {{ mediaBaseUrl: string }} options
 * @returns {{ model: object, decisions: object[], gaps: object, diagnostics: object, redirects: object[] }}
 * @throws {Error} When the snapshot has no active storefront, no system language or no default
 *   currency, or a locale has no Vendure language.
 */
export function buildModel(raw, { mediaBaseUrl }) {
    const lang = buildLanguages(raw.languages, SHOPWARE.LANGUAGE_SYSTEM);
    const storefront = pickStorefront(raw.sales_channels, SHOPWARE.SALES_CHANNEL_TYPE_STOREFRONT);
    const ctx = { ...lang, storefront };
    const defaultCurrency = raw.currencies.find(c => c.id === SHOPWARE.CURRENCY);
    if (!defaultCurrency) throw new Error(`The Shopware default currency ${SHOPWARE.CURRENCY} is not in the snapshot.`);
    const { decimals, source: decimalsSource } = currencyDecimals(defaultCurrency);
    const pricesIncludeTax = Boolean(storefront.display_gross);
    const pricing = { currencyId: SHOPWARE.CURRENCY, decimals, decimalsSource, pricesIncludeTax };

    const countries = buildCountries(raw, ctx);
    const tax = buildTax(raw, countries);

    const productSeo = seoPaths(raw.seo_urls, 'frontend.detail.page', ctx);
    const categorySeo = seoPaths(raw.seo_urls, 'frontend.navigation.page', ctx);
    const products = buildFamilies(raw, { ...ctx, pricing, productSlugOf: slugFromSeoOrName(productSeo) });
    const families = uniqueSlugsPerLanguage(products.families);
    const facets = buildFacets(raw, ctx);
    const membership = offersByCategory(families, o => o.listingCategoryIds);
    const cols = buildCollections(raw, { ...ctx, categorySlugOf: slugFromSeoOrName(categorySeo) }, membership);
    const collections = uniqueSlugsPerLanguage(cols.collections);
    const assets = buildAssets(raw, families, mediaBaseUrl, ctx);
    const { redirects, unmatched: unmatchedSeoUrls } = buildRedirects({ seoUrls: raw.seo_urls, families, collections, ctx });
    const gaps = buildGaps(raw, {
        families,
        collections,
        skippedLinks: cols.skippedLinks,
        redirects,
        unmatchedSeoUrls,
        problems: products.problems,
        familyIssues: products.familyIssues,
        taxGaps: tax.gaps,
        priceStats: products.priceStats,
        languageGaps: languageGaps(raw, lang.droppedLanguages),
        categoryIndexGaps: categoryIndexGaps(raw.categories, families, collections),
    });

    const allOffers = families.flatMap(f => f.offers);
    const expected = {
        products: families.length,
        variants: allOffers.length,
        families: families.filter(f => f.kind === 'family').length,
        simpleProducts: families.filter(f => f.kind === 'simple').length,
        variantsWithoutTaxAfterInheritance: products.problems.untaxed.length,
        optionGroups: families.reduce((n, f) => n + f.optionGroups.length, 0),
        facets: facets.facets.length,
        facetValues: facets.facets.reduce((n, f) => n + f.values.length, 0),
        collections: collections.length,
        collectionMemberships: collections.reduce((n, c) => n + c.offerSourceIds.length, 0),
        assets: assets.filter(a => !a.private).length,
        countries: countries.length,
        taxZones: tax.taxZones.length,
        taxRates: tax.taxZones.length * tax.taxCategories.length,
    };
    const model = {
        generatedAt: new Date().toISOString(),
        defaultLanguageCode: lang.defaultLanguageCode,
        languageCodes: lang.languageCodes,
        currencyCode: defaultCurrency.iso_code,
        currencyDecimals: decimals,
        pricesIncludeTax,
        countries,
        taxCategories: tax.taxCategories,
        taxZones: tax.taxZones,
        facets: facets.facets,
        families,
        collections,
        assets,
        expected,
    };
    const decisions = [
        ...lang.decisions,
        ...tax.decisions,
        ...products.decisions,
        ...facets.decisions,
        ...cols.decisions,
    ];
    const diagnostics = { provenance: products.provenance, optionUsage: products.optionUsage, familyIssues: products.familyIssues };
    return { model, decisions, gaps, diagnostics, redirects };
}

/**
 * Stage entry point: reads the snapshot, builds the model and writes model.json, decisions.json,
 * gaps.json, diagnostics.json and redirects.csv into the snapshot folder.
 * @param {{ source: { mediaBaseUrl: string } }} config
 * @param {string} snapshotDir
 * @returns {Promise<object>} The model.
 * @throws {Error} When the snapshot fails the manifest check (readSnapshot), see buildModel, and
 *   when an output file cannot be written.
 */
export async function transform(config, snapshotDir) {
    const { raw } = await readSnapshot(snapshotDir);
    const { model, decisions, gaps, diagnostics, redirects } = buildModel(raw, { mediaBaseUrl: config.source.mediaBaseUrl });
    await writeJson(path.join(snapshotDir, 'model.json'), model);
    await writeJson(path.join(snapshotDir, 'decisions.json'), decisions);
    await writeJson(path.join(snapshotDir, 'gaps.json'), gaps);
    await writeJson(path.join(snapshotDir, 'diagnostics.json'), diagnostics);
    await fs.writeFile(path.join(snapshotDir, 'redirects.csv'), redirectsCsv(redirects), 'utf8');

    const e = model.expected;
    const { provenance } = diagnostics;
    const p = gaps.problems;
    log(`transform: ${e.products} products, ${e.variants} variants (${e.families} families, ${e.simpleProducts} simple), ${e.collections} collections, ${e.assets} assets, ${e.taxZones} tax zones`);
    log(`transform: provenance ${JSON.stringify(provenance)}`);
    log(`transform: problems unpriced=${p.unpriced.length} untaxed=${p.untaxed.length} subCent=${p.subCentPrice.length} refusedOffers=${p.refusedOffers.length} familyIssues=${p.familyIssues.length}`);
    return model;
}
