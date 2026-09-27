# Coverage and limits

`gaps.json` and `sales-gaps.json` list every gap with a count for your shop. Run `extract` and `transform` once before deciding anything: most gaps below may not apply to you.

## Migrated

**Catalogue**

- **Products and variants.** A Shopware parent with children becomes one Vendure product whose variants are the children. The parent row itself never becomes a variant. A product without children becomes a product with one variant.
- **Base prices** in the default currency, as integer minor units, gross or net according to the storefront's customer group. See [Prices](catalogue.md#prices).
- **Stock**, as `stockOnHand` from Shopware's physical stock (`product.stock`).
- **Tax categories, tax rates and zones.** Countries with the same set of rates share one zone; the zone with the default rates becomes the channel's default tax zone. One more zone, "Storefront countries", holds the storefront's countries and becomes the default shipping zone.
- **Countries, languages and translations.** A country is enabled when it is active and assigned to the storefront.
- **Facets.** Property groups become facets, and the options that define variants become product options. Manufacturers become values of one `manufacturer` facet.
- **Collections** from categories, in the same tree and sibling order. An inactive category becomes a private collection.
- **Product images** and cover images. Private media are not uploaded.
- **Slugs.** Shopware SEO URLs are reused where they exist, otherwise the slug comes from the name. Slugs are made unique per language. `redirects.csv` lists each old path with its new slug.

**Customers and orders** — see [Customers and orders](customers-and-orders.md).

- Customers with addresses, groups, customer number and their bcrypt password hash; guests merged per email.
- Orders as finished historical records with lines, surcharges, shipping, payments, full refunds and fulfillments.

## Not migrated

- CMS layouts.
- Documents (invoices, delivery notes), partial captures and partial refunds as amounts (Shopware keeps those only in capture rows), returns, chargebacks, wishlists, newsletter subscriptions, tags. `sales-gaps.json` counts them.
- Salutation, birthday, company, VAT ids and newsletter state of customers. Shopware 5 legacy password hashes.
- **Rule prices** (Shopware's advanced prices). Only the base price is migrated. `transform` reports the rule prices in `gaps.json` with row and rule counts, and `oracle` measures how far the guest price in Shopware differs from the Vendure price. [`sketches/shopware-rule-prices/`](../sketches/shopware-rule-prices/README.md) holds a sketch of a Vendure plugin that could close this gap. It was never run and is not part of the migrator.
- **List prices** (the struck-through price). Vendure has no field for them; `gaps.json` counts them.
- Category media, manufacturer media and links, property option colours and media, cross-selling, product reviews, purchase and reference units, dimensions and weight.
- Payment methods and shipping rules.

## Known limits

- **Create and skip only.** A bound object is never updated, so changes made in Shopware after the first load do not reach Vendure. See [Bindings and re-runs](bindings-and-reruns.md).
- **Dynamic categories.** Collections from product-stream categories are created empty. Link categories are skipped, and their children move to the top level.
- **Visibility.** Vendure has channel membership, not visibility levels. Products with Shopware visibility 10 (hidden from listings and search) or 20 (hidden from listings) become normal, fully listed products, and so do products that are not visible in the storefront at all. `gaps.json` counts them.
- **Variant properties.** A variant with its own properties gets them as variant facet values next to the product's. Shopware replaces the parent's properties in that case; Vendure shows both.
- **One currency.** Only the default currency is migrated. Shopware derives the other currencies at runtime from a factor, and per-product prices in other currencies are ignored.
- **One sales channel.** Only the first active storefront sales channel, in id order, is read. Its countries, visibility, SEO URLs, navigation root and customer group price display are used.
- **Tax rules.** Only tax rules of type "entire country" are applied. Other rule types are counted in `gaps.json`.
- **Default tax category.** The Shopware tax with the lowest `position` becomes Vendure's default tax category. Shopware's own default tax setting (`core.tax.defaultTaxRate`) is not read; if it names another tax, change the default in Vendure after the load.
- **Default tax zone.** When every country has a tax rule that differs from the default rates, no zone matches the default rates, and `load` stops at the channel step.
- **Locales.** Only en-GB, en-US, de-DE, de-AT and de-CH are mapped to Vendure language codes. A language's content locale is its translation code, else its locale. `transform` stops with an error for any other locale; extend `LOCALE_TO_LANGUAGE` in `src/transform/languages.mjs`. When several Shopware languages map to one code (en-GB and en-US both become `en`), the system language wins, then a language without parent language, then the lowest id. The others are dropped, and `gaps.languages` counts their translation rows.
- **Hidden categories.** `category.visible = false` (hidden from navigation) has no Vendure field. It is kept in the model only.
- **Closeout and configurator prices.** The "closeout" flag and configurator price overrides are counted in `gaps.json` but not applied.
- **Versions.** Written and tested for Shopware 6.7 and Vendure 3.7.3. The SQL in `src/extract.mjs` and the constants in `src/config.mjs` would need checking for other versions.
