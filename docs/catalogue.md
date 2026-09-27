# Catalogue migration

Five stages carry the catalogue. Each reads the files of the previous one, so a stage can be re-run on its own.

```
extract ──> transform ──> load ──> verify
                           └─────> oracle
```

`npm run all` runs extract, transform, load and verify on a new snapshot. Under `all` the stages keep running after a recorded problem, so the verify report is still written; the exit code carries the outcome.

The exit code is 1 when a stage throws, when `load` records failures, when `verify` has a failed check, or when `oracle` finds resolver mismatches.

## extract

Reads the catalogue tables (and the customer and order tables used by the [sales stages](customers-and-orders.md)) from MySQL in one read-only transaction with a consistent snapshot, so all files describe the same moment even while the shop takes orders. Only the live version of versioned rows is read.

Creates a new snapshot folder named after the current time, for example `out/snapshots/2026-09-21T19-14-34-278Z/`, and writes:

- `raw/*.json`, one file per query.
- `manifest.extract.json`: the snapshot format (currently 2), row counts, a SHA-256 hash per file, and the MySQL version, migration count and UTC clock of the source.

If extract fails, no manifest is written, and later stages refuse the folder.

## transform

Reads only `raw/` and writes files, so it runs offline. It first checks the snapshot against its manifest and refuses it when the manifest is missing, was written in an older snapshot format, lacks a table transform needs, or a file's hash no longer matches. An old snapshot therefore has to be extracted again.

For the same snapshot and the same `SOURCE_MEDIA_BASE_URL` it writes the same files, apart from the `generatedAt` timestamp in `model.json`.

### How values are resolved

transform resolves the effective value of every field the way Shopware does:

- **Scalar inheritance.** A variant's NULL field inherits the parent's value. This covers price, tax, manufacturer, active flag, closeout flag and the cover image.
- **Association inheritance.** A variant without rows of its own in an association inherits the parent's rows as a whole. This covers categories, properties, media and visibility.
- **Translation fallback**, language by language, as Shopware's DAL does: for each language of the chain (requested language, its parent language, the system language) first the variant's own translation, then the parent's, then the next language. A variant with only an English name therefore shows its parent's German name in German. A value is only written to Vendure in the language it was authored in; other languages fall back to Vendure's default language, which gives the same text.
- **Variant names.** A variant whose name comes from the parent gets its option labels appended, for example "Hoodie Red / M", because Vendure lists variants by name.
- **Collection membership** follows the storefront listing. Shopware's `ProductListingRoute` filters on `categoriesRo`, which is the `product_category_tree` index: every category a product is assigned to plus all its ancestors. The migrator uses the same index.
- **Tax rates** are the tax rules in force at extract time: the newest `active_from` that is not later than the snapshot's clock. Rules that start later are listed in `gaps.taxRules` and need a manual rate change in Vendure on their date.

#### A stale category index

When the `product_category_tree` index is stale, `gaps.categoryIndex` counts the offers and memberships it misses; run `bin/console dal:refresh:index` on the source and extract again.

The index takes the ancestors from `category.path`, and `dal:refresh:index` runs the product indexer before the category indexer. After an import with stale category paths, the first run therefore indexes only the direct assignments, and a second run adds the ancestors. `gaps.categoryIndex.collectionsLosingMembers` shows this case; run the command until it is 0.

### Output

- `model.json`: the intermediate model that `load` creates in Vendure, plus the expected counts that `verify` checks.
- `decisions.json`: each mapping choice in plain text, for example how variants are named or how tax zones are formed.
- `gaps.json`: what is not migrated, with counts, and data problems in `gaps.problems` (offers without price or tax, sub-cent prices, invalid price JSON, variants that break Vendure's option rules, and the refused offers).
- `diagnostics.json`: how many values came from the parent product, per field.
- `redirects.csv`: RFC 4180 CSV with the columns `type`, `sourceId`, `language`, `from` and `toSlug`, one row per canonical storefront SEO URL of a product, a variant or a category. A variant redirects to its product's slug, since a Vendure variant has no page of its own. A language without its own slug redirects to the default-language slug.

## Prices

Prices are migrated in the default currency, as integer minor units. The number of decimals comes from the currency's `item_rounding`, else 2.

Whether the channel's prices include tax comes from the storefront's customer group (`display_gross`). With gross display the channel gets `pricesIncludeTax` and `load` sends the gross price; otherwise it sends the net price.

Shopware stores a gross and a net price per currency. When the entry is `linked: true`, Shopware derived one of the two from the other through the tax rate and stored it at full float precision. Such a derived value with more decimals than the currency is rounded half-up to the currency decimals and counted in `gaps.prices.grossRoundedFromLinked` or `gaps.prices.netRoundedFromLinked`. When the entry is not linked, both prices were entered by hand, and a sub-cent value is refused, never rounded.

### Refused offers

An offer whose price for the channel mode (gross or net) is missing or refused, or which has no tax after inheritance, is not created. Vendure 3.7.3 would store a null price as 0 and a missing tax category as its default one.

- `gaps.problems.refusedOffers` lists each such offer with its reasons.
- `load` records a failure for it, and a product none of whose offers can be created is not created either.
- Collections leave refused offers out and count them as `membersExcluded` in `load-result.json`.
- `verify` counts a refused offer as a missing variant, so it fails until the source data is fixed.

## load

Creates the model in Vendure through the Admin API, in dependency order:

1. global settings (available languages)
2. countries, zones, tax categories, tax rates
3. the default channel's settings (languages, currency, tax mode, default zones)
4. assets
5. facets
6. products with option groups and variants
7. collections

Collections get a variant-id filter with `inheritFilters` off, so a child category keeps exactly its own products.

**Held-back objects.** An object whose dependency is not bound yet, for example a variant whose image failed to upload, is held back instead of being created without it. `load` records a failure, and the next run retries it once the dependency exists.

**Failures.** A failure in the settings or channel step stops the load, since every later object depends on them. Any other failure is recorded per item and the load continues.

**Partly created objects.** A facet or option group that was only partly created is completed on the next run: `load` reads back the values Vendure has, matches them by code, and creates only the missing ones.

Writes `load-journal.ndjson` and `load-result.json` (counts, timings, failures) in the snapshot, and `bindings.json` in the output folder. See [Bindings and re-runs](bindings-and-reruns.md).

Run it against an empty Vendure. `verify` compares total counts, so it only passes when Vendure held nothing else before the load.

## verify

Waits for Vendure's job queue to drain (up to `VERIFY_JOB_WAIT_MINUTES`; retrying jobs count as not drained), then checks:

- Total counts of products, variants, facets, facet values, collections, assets, countries, zones (tax zones plus the shipping zone), tax rates and search index entries against the model.
- Background jobs in state FAILED since the load started, or all failed jobs when the snapshot has no `load-result.json`.
- That no model offer is left without a tax category after inheritance.
- Every variant against its model offer: bound and present, SKU, product, option combination, enabled flag, stock, the tax category by bound id, and the price in the channel mode (`priceWithTax` against the gross price when the channel's prices include tax, `price` against the net price otherwise).
- The number of variants in each collection with members.
- The product name in every model language, for every product with a name authored in that language.

Writes `verify-report.json` and a readable `report.md` with the checks, the background jobs, the load failures, the gaps and the decisions. Both name the snapshot and the migrator's git commit (marked `+dirty` when `src/` has uncommitted changes); `verify-report.json` also records the start of the hash of every extract file.

`verify` changes nothing in Vendure.

## oracle

Checks the migration against Shopware itself rather than against the migrator's own model. It needs the Shopware admin credentials and store access key, and reads the `product_price` and `rule` tables from MySQL. It changes nothing in Shopware or Vendure.

- **Resolver check.** The Admin API with inheritance enabled returns Shopware's resolved base price, tax and active flag per variant. Any difference to the model means the migrator's inheritance rules are wrong. The price check uses the channel mode, as `load` and `verify` do; `priceField` in the report says which. The Shopware price is converted to minor units by the same rule as in `transform`, so a linked sub-cent price that `transform` rounds is not a difference. The report lists differences under `resolver`, together with `missingInAdminApi` (offers the Admin API does not return) and `missingInVendure` (offers with no bound Vendure variant). `resolverMismatches` is the total of these lists. Offers listed in `gaps.problems.refusedOffers` are counted in `refusedOffers` instead: `load` does not create them, so their absence from Vendure is expected. A refused offer that is in Vendure anyway is compared like any other.
- **Guest view.** The Store API returns the name and the price a guest sees at quantity 1. The name is compared with Vendure. The guest price is compared with the channel-mode Vendure price; the report counts equal and different prices, which side is higher, and the largest and summed differences. This measures the effect of the rule-price gap.
- **Rule prices.** For products with rule prices it works out which rule set the guest price, matching it against each rule's quantity-1 price in the channel mode, and tests whether ordering rules by priority, then by id, predicts that choice. The winners are tallied by rule id.

Writes `oracle-report.json`, which also records the time of the measurement and its weekday in the Europe/Berlin time zone, since rules can depend on the day.
