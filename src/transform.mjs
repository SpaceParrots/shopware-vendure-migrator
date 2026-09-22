// Stage 2 + 3: resolve Shopware's effective values (live version, inheritance, translation
// fallback) and build a target-independent intermediate model, plus decisions and gaps.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SHOPWARE } from './config.mjs';
import { authoredOnly, byLangMap, groupTaxZones, inherit, inheritRows, resolveTranslated } from './lib/resolve.mjs';
import { groupBy, log, readJson, slugify, toMinorUnits, uniqueCoder, writeJson } from './lib/util.mjs';

// Shopware locale -> Vendure LanguageCode. Base codes on purpose: one storefront per language.
const LOCALE_TO_LANGUAGE = { 'en-GB': 'en', 'en-US': 'en', 'de-DE': 'de', 'de-AT': 'de', 'de-CH': 'de' };
const FULL_VISIBILITY = 30; // ProductVisibilityDefinition::VISIBILITY_ALL

export async function transform(config, snapshotDir) {
    const raw = {};
    for (const file of await fs.readdir(path.join(snapshotDir, 'raw'))) {
        raw[file.replace(/\.json$/, '')] = await readJson(path.join(snapshotDir, 'raw', file));
    }
    const decisions = [];
    const gaps = {};
    const decide = (topic, text) => decisions.push({ topic, text });

    // ----- languages -------------------------------------------------------------------
    const languages = raw.languages.map(l => ({
        sourceId: l.id,
        parentId: l.parent_id,
        locale: l.locale,
        code: LOCALE_TO_LANGUAGE[l.locale],
        isSystem: l.id === SHOPWARE.LANGUAGE_SYSTEM,
    }));
    const unmapped = languages.filter(l => !l.code);
    if (unmapped.length) throw new Error(`No Vendure language for locales: ${unmapped.map(l => l.locale).join(', ')}`);
    const langById = new Map(languages.map(l => [l.sourceId, l]));
    const systemLanguage = languages.find(l => l.isSystem);
    const defaultLanguageCode = systemLanguage.code;
    decide('languages', `Shopware system language ${systemLanguage.locale} becomes Vendure default language "${defaultLanguageCode}". Locales map to base codes (${languages.map(l => `${l.locale}->${l.code}`).join(', ')}).`);

    // Bound to this shop's languages; the rules themselves live in lib/resolve.mjs.
    const translated = (ownByLang, parentByLang, field) => resolveTranslated(languages, ownByLang, parentByLang, field);
    const authored = resolved => authoredOnly(resolved, defaultLanguageCode);

    // ----- sales channel, countries, tax ------------------------------------------------
    const storefront = raw.sales_channels.find(sc => sc.type_id === SHOPWARE.SALES_CHANNEL_TYPE_STOREFRONT);
    if (!storefront) throw new Error('No storefront sales channel found.');
    const storefrontCountryIds = new Set(
        raw.sales_channel_countries.filter(r => r.sales_channel_id === storefront.id).map(r => r.country_id),
    );
    const countryNames = groupBy(raw.country_translations, 'country_id');
    const countries = raw.countries.map(c => {
        const names = {};
        for (const t of countryNames.get(c.id) ?? []) names[langById.get(t.language_id).code] = t.name;
        return {
            sourceId: c.id,
            code: c.iso,
            names,
            enabled: Boolean(c.active) && storefrontCountryIds.has(c.id),
        };
    });
    const countryById = new Map(countries.map(c => [c.sourceId, c]));

    const taxCategories = raw.taxes
        .sort((a, b) => a.position - b.position)
        .map((t, i) => ({ sourceId: t.id, name: t.name, defaultRate: Number(t.tax_rate), isDefault: i === 0 }));
    const nonCountryRules = raw.tax_rules.filter(r => r.type !== 'entire_country');
    if (nonCountryRules.length) {
        gaps.taxRulesNotCountryWide = nonCountryRules.length;
    }
    const { taxZones, defaultTuple } = groupTaxZones(countries, taxCategories, raw.tax_rules);
    decide('tax', `Shopware applies a tax's default rate everywhere except countries with a tax_rule. Vendure rates belong to zones, so countries are grouped by their rate tuple (${taxCategories.map(t => t.name).join(' / ')}) into ${taxZones.length} tax zones. The zone matching the default rates (${defaultTuple}) is the channel's default tax zone.`);

    // ----- products: effective values -------------------------------------------------------
    const productById = new Map(raw.products.map(p => [p.id, p]));
    const childrenOf = groupBy(raw.products.filter(p => p.parent_id), 'parent_id');
    const translationsOf = groupBy(raw.product_translations, 'product_id');
    const optionsOf = groupBy(raw.product_options, 'product_id');
    const propertiesOf = groupBy(raw.product_properties, 'product_id');
    const categoriesOf = groupBy(raw.product_categories, 'product_id');
    const mediaOf = groupBy(raw.product_media, 'product_id');
    const productMediaById = new Map(raw.product_media.map(pm => [pm.id, pm]));
    const visibilityOf = groupBy(raw.product_visibilities.filter(v => v.sales_channel_id === storefront.id), 'product_id');

    // Property groups and options.
    const groupNames = groupBy(raw.property_group_translations, 'group_id');
    const optionNames = groupBy(raw.property_group_option_translations, 'option_id');
    const optionById = new Map(raw.property_group_options.map(o => [o.id, o]));
    const namesByLang = rows => {
        const out = {};
        for (const r of rows ?? []) out[langById.get(r.language_id).code] = r.name;
        return out;
    };
    const optionLabel = (optionId, code) => {
        const names = namesByLang(optionNames.get(optionId));
        return names[code] ?? names[defaultLanguageCode] ?? optionId;
    };

    // Manufacturers.
    const manufacturerNames = groupBy(raw.manufacturer_translations, 'manufacturer_id');

    const priceKey = `c${SHOPWARE.CURRENCY}`;
    const problems = { unpriced: [], untaxed: [], subCentPrice: [], nonDefaultCurrencyOnly: [] };
    const provenance = { priceFromParent: 0, taxFromParent: 0, manufacturerFromParent: 0, activeFromParent: 0, categoriesFromParent: 0, propertiesFromParent: 0, mediaFromParent: 0 };

    const offerFromRow = (row, parent) => {
        const price = inherit(row, parent, 'price');
        const tax = inherit(row, parent, 'tax_id');
        const manufacturer = inherit(row, parent, 'manufacturer_id');
        const active = inherit(row, parent, 'active');
        if (price.from === 'parent') provenance.priceFromParent++;
        if (tax.from === 'parent') provenance.taxFromParent++;
        if (manufacturer.from === 'parent') provenance.manufacturerFromParent++;
        if (active.from === 'parent') provenance.activeFromParent++;

        let priceGrossMinor = null;
        const priceJson = typeof price.value === 'string' ? JSON.parse(price.value) : price.value;
        if (!priceJson) problems.unpriced.push(row.product_number);
        else if (!priceJson[priceKey]) problems.nonDefaultCurrencyOnly.push(row.product_number);
        else {
            const minor = toMinorUnits(priceJson[priceKey].gross);
            if (minor.ok) priceGrossMinor = minor.minor;
            else problems.subCentPrice.push({ sku: row.product_number, gross: priceJson[priceKey].gross });
        }
        if (!tax.value) problems.untaxed.push(row.product_number);

        const categories = inheritRows(categoriesOf, row, parent);
        const properties = inheritRows(propertiesOf, row, parent);
        if (categories.from === 'parent') provenance.categoriesFromParent++;
        if (properties.from === 'parent') provenance.propertiesFromParent++;

        const ownMedia = (mediaOf.get(row.id) ?? []).sort((a, b) => a.position - b.position);
        const cover = row.cover_product_media_id ? productMediaById.get(row.cover_product_media_id) : undefined;

        return {
            sourceId: row.id,
            sku: row.product_number,
            enabled: Boolean(active.value),
            priceGrossMinor,
            taxSourceId: tax.value,
            manufacturerSourceId: manufacturer.value,
            stockOnHand: Number(row.stock),
            isCloseout: Boolean(inherit(row, parent, 'is_closeout').value),
            optionSourceIds: (optionsOf.get(row.id) ?? []).map(o => o.option_id),
            ownPropertyOptionIds: (propertiesOf.get(row.id) ?? []).map(p => p.option_id),
            effectiveCategoryIds: categories.rows.map(c => c.category_id),
            mediaSourceIds: ownMedia.map(m => m.media_id),
            coverMediaSourceId: cover?.media_id ?? null,
            // visibilities is an inherited association, like categories and properties.
            storefrontVisibility: inheritRows(visibilityOf, row, parent).rows.map(v => v.visibility),
        };
    };

    // ----- families -------------------------------------------------------------------------
    const productSlugs = new Map();
    for (const s of raw.seo_urls.filter(s => s.route_name === 'frontend.detail.page' && s.sales_channel_id === storefront.id)) {
        productSlugs.set(`${s.foreign_key}|${langById.get(s.language_id).code}`, s.seo_path_info);
    }
    const redirects = [];
    const families = [];
    const optionUsage = { parentsWithOptionRows: 0 };

    for (const row of raw.products.filter(p => !p.parent_id)) {
        const children = childrenOf.get(row.id) ?? [];
        const isFamily = children.length > 0;
        const ownTranslations = byLangMap(translationsOf.get(row.id) ?? []);
        const names = translated(ownTranslations, null, 'name');
        const descriptions = translated(ownTranslations, null, 'description');
        if ((optionsOf.get(row.id) ?? []).length) optionUsage.parentsWithOptionRows++;

        const slugs = {};
        for (const code of Object.keys(authored(names))) {
            const seo = productSlugs.get(`${row.id}|${code}`);
            slugs[code] = seo ? slugify(seo) : slugify(names[code].value);
            if (seo) redirects.push({ type: 'product', sourceId: row.id, language: code, from: `/${seo}`, toSlug: slugs[code] });
        }

        const familyMedia = (mediaOf.get(row.id) ?? []).sort((a, b) => a.position - b.position).map(m => m.media_id);
        const cover = row.cover_product_media_id ? productMediaById.get(row.cover_product_media_id)?.media_id : null;
        const family = {
            sourceId: row.id,
            kind: isFamily ? 'family' : 'simple',
            sku: row.product_number,
            names: authored(names),
            descriptions: authored(descriptions),
            slugs,
            enabled: Boolean(row.active),
            propertyOptionIds: (propertiesOf.get(row.id) ?? []).map(p => p.option_id),
            manufacturerSourceId: row.manufacturer_id,
            mediaSourceIds: familyMedia,
            coverMediaSourceId: cover ?? familyMedia[0] ?? null,
            optionGroups: [],
            offers: [],
        };

        if (!isFamily) {
            const offer = offerFromRow(row, null);
            offer.names = family.names;
            family.offers.push(offer);
        } else {
            for (const child of children) {
                const offer = offerFromRow(child, row);
                const childNames = translated(byLangMap(translationsOf.get(child.id) ?? []), ownTranslations, 'name');
                const variantNames = {};
                for (const [code, r] of Object.entries(childNames)) {
                    if (r.authoredIn !== code && code !== defaultLanguageCode) continue;
                    // Inherited name: append the option labels so variants are distinguishable.
                    const suffix = r.owner === 'parent' && offer.optionSourceIds.length
                        ? ` ${offer.optionSourceIds.map(o => optionLabel(o, code)).join(' / ')}`
                        : '';
                    variantNames[code] = `${r.value}${suffix}`;
                }
                offer.names = variantNames;
                family.offers.push(offer);
            }
            // Option groups = groups used by the variants, options = the ones actually used.
            const groups = new Map();
            for (const offer of family.offers) {
                for (const optionId of offer.optionSourceIds) {
                    const groupId = optionById.get(optionId)?.group_id;
                    if (!groups.has(groupId)) groups.set(groupId, new Set());
                    groups.get(groupId).add(optionId);
                }
            }
            family.optionGroups = [...groups.entries()].map(([groupId, opts]) => ({
                sourceId: groupId,
                names: namesByLang(groupNames.get(groupId)),
                optionSourceIds: [...opts],
            }));
        }
        families.push(family);
    }
    decide('variants', 'A Shopware parent with children becomes one Vendure Product; only the children become ProductVariants. The parent row itself is never turned into a buyable variant. A product without children becomes a Product with exactly one variant.');
    decide('variant names', 'Variants whose name is inherited from the parent get the option labels appended (e.g. "Hoodie Red / M"), because Vendure lists variants by name. Variants with their own name keep it unchanged.');
    decide('translations', 'Translated values are resolved in Shopware DAL order (child language chain, then parent language chain, the chain ending in the system language). A translation is only written to Vendure when the value was authored in that language; otherwise Vendure falls back to the default language, which yields the same text Shopware shows.');
    decide('stock', 'stockOnHand is product.stock (physical). available_stock is not used; open orders are not migrated, so there is nothing to allocate against in Vendure yet.');

    // ----- consistency checks Vendure will enforce ------------------------------------------
    const familyIssues = [];
    for (const family of families.filter(f => f.kind === 'family')) {
        const groupCount = family.optionGroups.length;
        const combos = new Set();
        for (const offer of family.offers) {
            const perGroup = new Set(offer.optionSourceIds.map(o => optionById.get(o)?.group_id));
            if (perGroup.size !== groupCount || offer.optionSourceIds.length !== groupCount) {
                familyIssues.push({ family: family.sku, sku: offer.sku, issue: 'variant does not have exactly one option per option group' });
            }
            const combo = [...offer.optionSourceIds].sort().join('+');
            if (combos.has(combo)) familyIssues.push({ family: family.sku, sku: offer.sku, issue: 'duplicate option combination' });
            combos.add(combo);
        }
    }

    // ----- facets -------------------------------------------------------------------------
    const facetCodes = uniqueCoder();
    const facets = raw.property_groups.map(g => {
        const names = namesByLang(groupNames.get(g.id));
        const valueCodes = uniqueCoder();
        return {
            sourceId: g.id,
            kind: 'property',
            code: facetCodes(`prop-${slugify(names[defaultLanguageCode] ?? g.id)}`),
            names,
            values: raw.property_group_options
                .filter(o => o.group_id === g.id)
                .map(o => {
                    const on = namesByLang(optionNames.get(o.id));
                    return { sourceId: o.id, code: valueCodes(slugify(on[defaultLanguageCode] ?? o.id)), names: on };
                }),
        };
    });
    const usedManufacturers = new Set(raw.products.map(p => p.manufacturer_id).filter(Boolean));
    const manufacturerValueCodes = uniqueCoder();
    facets.push({
        sourceId: 'manufacturer',
        kind: 'manufacturer',
        code: facetCodes('manufacturer'),
        names: { en: 'Manufacturer', de: 'Hersteller' },
        values: raw.manufacturers
            .filter(m => usedManufacturers.has(m.id))
            .map(m => {
                const mn = namesByLang(manufacturerNames.get(m.id));
                return { sourceId: m.id, code: manufacturerValueCodes(slugify(mn[defaultLanguageCode] ?? m.id)), names: mn };
            }),
    });
    decide('facets', 'Every Shopware property group becomes a Vendure Facet with its options as FacetValues; manufacturers become values of one "manufacturer" facet. Variant-defining options become ProductOptions separately; a group used both ways exists in both forms.');
    decide('variant facets', 'Product-level facet values come from the parent; a variant with its own product_property rows also gets those as variant facet values. Shopware replaces the parent set in that case, Vendure unions product and variant values: a documented deviation.');

    // ----- collections ---------------------------------------------------------------------
    const categoryNames = groupBy(raw.category_translations, 'category_id');
    const categorySlugs = new Map();
    for (const s of raw.seo_urls.filter(s => s.route_name === 'frontend.navigation.page' && s.sales_channel_id === storefront.id)) {
        categorySlugs.set(`${s.foreign_key}|${langById.get(s.language_id).code}`, s.seo_path_info);
    }
    const offersByCategory = new Map();
    for (const family of families) {
        for (const offer of family.offers) {
            for (const categoryId of offer.effectiveCategoryIds) {
                if (!offersByCategory.has(categoryId)) offersByCategory.set(categoryId, []);
                offersByCategory.get(categoryId).push(offer.sourceId);
            }
        }
    }
    // Sibling order: Shopware stores a linked list via after_category_id.
    const siblingsOf = groupBy(raw.categories, c => c.parent_id ?? 'root');
    const ordered = [];
    const visit = parentKey => {
        const siblings = siblingsOf.get(parentKey) ?? [];
        const byAfter = new Map(siblings.map(s => [s.after_category_id ?? 'first', s]));
        const sequence = [];
        let cursor = byAfter.get('first');
        const seen = new Set();
        while (cursor && !seen.has(cursor.id)) {
            sequence.push(cursor);
            seen.add(cursor.id);
            cursor = byAfter.get(cursor.id);
        }
        // Broken chains: append the rest in id order rather than losing them.
        for (const s of siblings) if (!seen.has(s.id)) sequence.push(s);
        for (const s of sequence) {
            ordered.push(s);
            visit(s.id);
        }
    };
    visit('root');

    const collections = [];
    const skippedLinks = [];
    for (const c of ordered) {
        if (c.type === 'link') {
            skippedLinks.push(c.id);
            continue;
        }
        const own = byLangMap(categoryNames.get(c.id) ?? []);
        const names = authored(translated(own, null, 'name'));
        const descriptions = authored(translated(own, null, 'description'));
        const slugs = {};
        for (const code of Object.keys(names)) {
            const seo = categorySlugs.get(`${c.id}|${code}`);
            slugs[code] = seo ? slugify(seo) : slugify(names[code]);
            if (seo) redirects.push({ type: 'category', sourceId: c.id, language: code, from: `/${seo}`, toSlug: slugs[code] });
        }
        collections.push({
            sourceId: c.id,
            parentSourceId: c.parent_id,
            level: c.level,
            names,
            descriptions,
            slugs,
            isPrivate: !c.active,
            hiddenInNavigation: !c.visible,
            isStorefrontRoot: c.id === storefront.navigation_category_id,
            assignment: c.product_assignment_type,
            offerSourceIds: c.product_assignment_type === 'product' ? offersByCategory.get(c.id) ?? [] : [],
        });
    }
    // Link categories are skipped; their children would lose their parent.
    const skippedSet = new Set(skippedLinks);
    const orphaned = collections.filter(c => skippedSet.has(c.parentSourceId));
    for (const c of orphaned) c.parentSourceId = null;
    decide('collections', 'Each Shopware page or folder category becomes a Collection in the same tree position and sibling order. Membership uses a variant-id filter with inheritFilters=false, so a child category keeps exactly its own assignments instead of being intersected with the parent (Vendure\'s default).');
    decide('collection visibility', 'category.active=false becomes isPrivate. category.visible=false (hidden from navigation) has no Vendure equivalent and is kept only in the model for the storefront to use.');

    // ----- assets -------------------------------------------------------------------------
    const usedMedia = new Set();
    for (const f of families) {
        f.mediaSourceIds.forEach(m => usedMedia.add(m));
        if (f.coverMediaSourceId) usedMedia.add(f.coverMediaSourceId);
        for (const o of f.offers) {
            o.mediaSourceIds.forEach(m => usedMedia.add(m));
            if (o.coverMediaSourceId) usedMedia.add(o.coverMediaSourceId);
        }
    }
    const mediaNames = groupBy(raw.media_translations, 'media_id');
    const assets = raw.media
        .filter(m => usedMedia.has(m.id))
        .map(m => ({
            sourceId: m.id,
            url: `${config.source.mediaBaseUrl.replace(/\/$/, '')}/${m.path}`,
            fileName: `${m.file_name}.${m.file_extension}`,
            mimeType: m.mime_type,
            private: Boolean(m.private),
            alt: namesByLang((mediaNames.get(m.id) ?? []).map(t => ({ ...t, name: t.alt }))),
        }));

    // ----- gaps -----------------------------------------------------------------------------
    const allOffers = families.flatMap(f => f.offers);
    const ruleNames = new Map(raw.rules.map(r => [r.id, r]));
    const tierRows = raw.product_price_summary.reduce((n, r) => n + Number(r.tiers), 0);
    gaps.rulePrices = {
        verdict: 'not migrated; solution sketched as price strategies in sketches/shopware-rule-prices (never run)',
        rows: tierRows,
        rules: [...groupBy(raw.product_price_summary, 'rule_id').entries()].map(([ruleId, rows]) => ({
            name: ruleNames.get(ruleId)?.name,
            priority: ruleNames.get(ruleId)?.priority,
            products: rows.length,
            tiers: rows.reduce((n, r) => n + Number(r.tiers), 0),
        })),
    };
    gaps.currencies = {
        verdict: 'only the default currency is stored per product; Shopware derives the others at runtime from currency.factor',
        notMigrated: raw.currencies.filter(c => c.id !== SHOPWARE.CURRENCY).map(c => `${c.iso_code} (factor ${c.factor})`),
    };
    gaps.visibility = {
        verdict: 'Vendure has channel membership, not per-channel visibility levels',
        offersNotFullyVisibleInStorefront: allOffers.filter(o => !o.storefrontVisibility.includes(FULL_VISIBILITY)).length,
    };
    gaps.categories = {
        productStreamCategories: collections.filter(c => c.assignment === 'product_stream').length,
        linkCategoriesSkipped: skippedLinks.length,
        hiddenInNavigation: collections.filter(c => c.hiddenInNavigation).length,
        verdict: 'dynamic (product stream) membership is not migrated; those collections are created empty',
    };
    gaps.closeout = {
        offers: allOffers.filter(o => o.isCloseout).length,
        verdict: 'is_closeout (do not sell when out of stock) maps to Vendure out-of-stock settings; not configured in this slice',
    };
    const configuratorByProduct = groupBy(raw.product_configurator_settings, 'product_id');
    let configuratorUnused = 0;
    for (const f of families.filter(f => f.kind === 'family')) {
        const used = new Set(f.offers.flatMap(o => o.optionSourceIds));
        for (const s of configuratorByProduct.get(f.sourceId) ?? []) if (!used.has(s.option_id)) configuratorUnused++;
    }
    gaps.configurator = {
        settingsWithPriceOverride: raw.product_configurator_settings.filter(s => Number(s.has_price_override)).length,
        settingsForOptionsNoVariantUses: configuratorUnused,
    };
    gaps.seo = {
        productsWithSeoUrl: new Set(redirects.filter(r => r.type === 'product').map(r => r.sourceId)).size,
        productsTotal: families.length,
        categoriesWithSeoUrl: new Set(redirects.filter(r => r.type === 'category').map(r => r.sourceId)).size,
        verdict: 'products without a Shopware SEO URL get a slug from their name; the source shop has not generated most SEO URLs',
    };
    gaps.notInSlice = ['customers', 'orders', 'CMS layouts (every category references one)', 'category media', 'manufacturer media and links', 'property option colours and media', 'cross-selling', 'product reviews', 'purchase and reference units', 'dimensions and weight'];
    gaps.problems = { ...problems, familyIssues };

    // ----- expectations for verify ----------------------------------------------------------
    const expected = {
        products: families.length,
        variants: allOffers.length,
        families: families.filter(f => f.kind === 'family').length,
        simpleProducts: families.filter(f => f.kind === 'simple').length,
        variantsWithoutTaxAfterInheritance: problems.untaxed.length,
        optionGroups: families.reduce((n, f) => n + f.optionGroups.length, 0),
        facets: facets.length,
        facetValues: facets.reduce((n, f) => n + f.values.length, 0),
        collections: collections.length,
        assets: assets.filter(a => !a.private).length,
        countries: countries.length,
        taxZones: taxZones.length,
        taxRates: taxZones.length * taxCategories.length,
    };

    const model = {
        generatedAt: new Date().toISOString(),
        defaultLanguageCode,
        languageCodes: [...new Set(languages.map(l => l.code))],
        currencyCode: raw.currencies.find(c => c.id === SHOPWARE.CURRENCY).iso_code,
        pricesIncludeTax: Boolean(storefront.display_gross),
        countries,
        taxCategories,
        taxZones,
        facets,
        families,
        collections,
        assets,
        expected,
    };
    await writeJson(path.join(snapshotDir, 'model.json'), model);
    await writeJson(path.join(snapshotDir, 'decisions.json'), decisions);
    await writeJson(path.join(snapshotDir, 'gaps.json'), gaps);
    await writeJson(path.join(snapshotDir, 'diagnostics.json'), { provenance, optionUsage, familyIssues });
    const csv = ['type,sourceId,language,from,toSlug', ...redirects.map(r => [r.type, r.sourceId, r.language, r.from, r.toSlug].join(','))];
    await fs.writeFile(path.join(snapshotDir, 'redirects.csv'), csv.join('\n'), 'utf8');

    log(`transform: ${expected.products} products, ${expected.variants} variants (${expected.families} families, ${expected.simpleProducts} simple), ${expected.collections} collections, ${expected.assets} assets, ${taxZones.length} tax zones`);
    log(`transform: provenance ${JSON.stringify(provenance)}`);
    log(`transform: problems unpriced=${problems.unpriced.length} untaxed=${problems.untaxed.length} subCent=${problems.subCentPrice.length} familyIssues=${familyIssues.length}`);
    return model;
}
