# Shopware 6 to Vendure 3 catalogue migrator

A command-line tool that copies the product catalogue of a Shopware 6.7 shop into Vendure 3.7. It reads the Shopware database directly, resolves the values Shopware would show (variant inheritance, translation fallback, tax per country), writes an intermediate model to disk, and creates that model in Vendure through the Admin API. Two check stages then compare the result with the model and with Shopware's own APIs.

It was tested against Shopware 6.7.0.0 (the `dockware/dev` image with the demo-data plugin) and Vendure 3.7.3. Other versions may work, but the SQL in `src/extract.mjs` and the constants in `src/config.mjs` are written for 6.7.

The tool is experimental. It is meant to be read and adapted, not run unchanged against a production shop.

## What it migrates

- Products and variants. A Shopware parent with children becomes one Vendure product whose variants are the children. The parent row itself never becomes a variant. A product without children becomes a product with one variant.
- Base prices in the default currency, as integer minor units. The number of decimals comes from the currency's `item_rounding`, else 2. Whether the channel's prices include tax comes from the storefront's customer group (`display_gross`): with gross display the channel gets `pricesIncludeTax` and `load` sends the gross price, otherwise it sends the net price. See "Prices" below for rounding and refused prices.
- Stock, as `stockOnHand` from Shopware's physical stock (`product.stock`).
- Tax categories, tax rates and zones. Countries with the same set of rates share one zone; the zone with the default rates becomes the channel's default tax zone. One more zone, "Storefront countries", holds the storefront's countries and becomes the default shipping zone.
- Countries, languages and translations. A country is enabled when it is active and assigned to the storefront.
- Property groups as facets, and the options that define variants as product options. Manufacturers become values of one `manufacturer` facet.
- Categories as collections, in the same tree and sibling order. An inactive category becomes a private collection.
- Product images and cover images. Private media are not uploaded.
- Slugs. Shopware SEO URLs are reused where they exist, otherwise the slug comes from the name. Slugs are made unique per language. `redirects.csv` lists each old path with its new slug.

## What it does not migrate

- Customers, orders and CMS layouts.
- Rule prices (Shopware's advanced prices). Only the base price is migrated. `transform` reports the rule prices in `gaps.json` with row and rule counts, and `oracle` measures how far the guest price in Shopware differs from the Vendure price. `sketches/shopware-rule-prices/` holds a sketch of a Vendure plugin that could close this gap. It was never run and is not part of the migrator.
- List prices (the struck-through price). Vendure has no field for them; `gaps.json` counts them.
- Category media, manufacturer media and links, property option colours and media, cross-selling, product reviews, purchase and reference units, dimensions and weight.

`gaps.json` lists every gap with a count, so you can see what applies to your shop before deciding anything.

## Requirements

- Node.js 22.9 or later. No build step. The only dependency is `mysql2`.
- Read access to the Shopware MySQL database.
- HTTP access to the shop, so `load` can download product images.
- A Vendure 3.7 server with bearer tokens enabled (`authOptions.tokenMethod` includes `'bearer'`), an asset server and a search plugin, and an administrator account that can change the global settings and the default channel and create catalogue entities.
- A running Vendure worker for `verify`, which waits for the job queue to drain.
- For `oracle` only: a Shopware admin user and the Store API access key of the storefront sales channel.

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env`. Every variable has a one-line comment in `.env.example`. The npm scripts load `.env` if it exists; variables already set in the shell take precedence. If you call `node src/cli.mjs` directly, set the variables yourself or pass `--env-file=.env`.

Each stage requires only the credentials it uses. `transform` needs none, since it connects to nothing. An empty value counts as unset. A stage with a missing credential or an invalid value stops before it does anything and names every problem at once.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `SOURCE_DB_HOST` | `127.0.0.1` | extract, oracle | Host of the Shopware database. |
| `SOURCE_DB_PORT` | `3306` | extract, oracle | Port of the Shopware database, an integer from 1 to 65535. |
| `SOURCE_DB_NAME` | `shopware` | extract, oracle | Name of the Shopware database. |
| `SOURCE_DB_USER` | none, required | extract, oracle, all | Database user; read access is enough. |
| `SOURCE_DB_PASSWORD` | none, required | extract, oracle, all | Password of that user. |
| `SOURCE_MEDIA_BASE_URL` | `http://localhost` | transform, oracle | Public base URL of the shop, http or https. `transform` builds the image URLs in `model.json` from it, which `load` then downloads. `oracle` calls the Admin and Store API under it. |
| `SOURCE_LABEL` | `unlabelled` | extract | Free-text name of the source install, written into the extract manifest and from there into the verify report. |
| `SOURCE_ADMIN_USER` | none, required | oracle | Shopware admin user for the Admin API login. |
| `SOURCE_ADMIN_PASSWORD` | none, required | oracle | Password of that admin user. |
| `SOURCE_STORE_ACCESS_KEY` | none, required | oracle | Store API access key of the storefront sales channel. |
| `VENDURE_ADMIN_API` | `http://localhost:3000/admin-api` | load, verify, oracle | URL of the Vendure Admin API, http or https. A trailing slash is dropped. `bindings.json` records it, and a different URL is refused. |
| `VENDURE_USERNAME` | none, required | load, verify, oracle, all | Vendure administrator identifier. |
| `VENDURE_PASSWORD` | none, required | load, verify, oracle, all | Password of that administrator. |
| `TARGET_LABEL` | `unlabelled` | verify | Free-text name of the target install, written into the verify report. |
| `VERIFY_JOB_WAIT_MINUTES` | `45` | verify | Minutes `verify` waits for the Vendure job queue to drain before it gives up. A number, 0 or more. |
| `MIGRATOR_HTTP_TIMEOUT_SECONDS` | `30` | load, verify, oracle | Seconds one HTTP attempt may take, including reading the body. A number, 1 or more. |
| `MIGRATOR_HTTP_RETRIES` | `3` | load, verify, oracle | Extra attempts after a timeout, a network error or HTTP 408, 425, 429, 500, 502, 503 or 504, with a wait of 500 ms that doubles each time. Only reads, logins and image downloads retry, never creates. An integer from 0 to 10. |
| `MIGRATOR_OUT_DIR` | `out` | every stage | Folder for snapshots and `bindings.json`, relative to the working directory. |

## Running

```sh
npm run extract
npm run transform
npm run load
npm run verify
npm run oracle
```

`npm run all` runs extract, transform, load and verify in one go. `npm run help` prints the usage.

Each stage reads the files of the previous one, so a stage can be re-run on its own. All files go to `out/` (or `MIGRATOR_OUT_DIR`). `extract` and `all` create a new snapshot folder named after the current time, for example `out/snapshots/2026-09-21T19-14-34-278Z/`. The other stages use the newest snapshot unless you name one. Only folders with such a timestamp name count as the newest, and `--snapshot` takes a folder name inside `snapshots/`, not a path:

```sh
npm run transform -- --snapshot 2026-09-21T19-14-34-278Z
```

The exit code is 1 when a stage throws, when `load` records failures, when `verify` has a failed check, or when `oracle` finds resolver mismatches. Under `all` the stages keep running after a recorded problem, so the verify report is still written.

### extract

Reads the catalogue tables from MySQL in one read-only transaction with a consistent snapshot, so all files describe the same moment even while the shop takes orders. Only the live version of versioned rows is read.

Writes `raw/*.json` (one file per query) and `manifest.extract.json`: the snapshot format (currently 2), row counts, a SHA-256 hash per file, and the MySQL version, migration count and UTC clock of the source. If extract fails, no manifest is written.

### transform

Reads only `raw/` and writes files, so it runs offline. It first checks the snapshot against its manifest and refuses it when the manifest is missing, was written in an older snapshot format, lacks a table transform needs, or a file's hash no longer matches. An old snapshot therefore has to be extracted again.

For the same snapshot and the same `SOURCE_MEDIA_BASE_URL` it writes the same files, apart from the `generatedAt` timestamp in `model.json`. It resolves the effective value of every field the way Shopware does:

- A variant's NULL field inherits the parent's value. This covers price, tax, manufacturer, active flag, closeout flag and the cover image.
- A variant without rows of its own in an association inherits the parent's rows as a whole. This covers categories, properties, media and visibility.
- Translations fall back language by language, as Shopware's DAL does: for each language of the chain (requested language, its parent language, the system language) first the variant's own translation, then the parent's, then the next language. A variant with only an English name therefore shows its parent's German name in German. A value is only written to Vendure in the language it was authored in; other languages fall back to Vendure's default language, which gives the same text.
- A variant whose name comes from the parent gets its option labels appended, for example "Hoodie Red / M", because Vendure lists variants by name.
- Collection membership follows the storefront listing. Shopware's `ProductListingRoute` filters on `categoriesRo`, which is the `product_category_tree` index: every category a product is assigned to plus all its ancestors. The migrator uses the same index. When the index is stale, `gaps.categoryIndex` counts the offers and memberships it misses; run `bin/console dal:refresh:index` on the source and extract again. The index takes the ancestors from `category.path`, and `dal:refresh:index` runs the product indexer before the category indexer. After an import with stale category paths, the first run therefore indexes only the direct assignments, and a second run adds the ancestors. `gaps.categoryIndex.collectionsLosingMembers` shows this case; run the command until it is 0.
- Tax rates are the tax rules in force at extract time: the newest `active_from` that is not later than the snapshot's clock. Rules that start later are listed in `gaps.taxRules` and need a manual rate change in Vendure on their date.

Writes:

- `model.json`: the intermediate model that `load` creates in Vendure, plus the expected counts that `verify` checks.
- `decisions.json`: each mapping choice in plain text, for example how variants are named or how tax zones are formed.
- `gaps.json`: what is not migrated, with counts, and data problems in `gaps.problems` (offers without price or tax, sub-cent prices, invalid price JSON, variants that break Vendure's option rules, and the refused offers).
- `diagnostics.json`: how many values came from the parent product, per field.
- `redirects.csv`: RFC 4180 CSV with the columns `type`, `sourceId`, `language`, `from` and `toSlug`, one row per canonical storefront SEO URL of a product, a variant or a category. A variant redirects to its product's slug, since a Vendure variant has no page of its own. A language without its own slug redirects to the default-language slug.

### Prices

Shopware stores a gross and a net price per currency. When the entry is `linked: true`, Shopware derived one of the two from the other through the tax rate and stored it at full float precision. Such a derived value with more decimals than the currency is rounded half-up to the currency decimals and counted in `gaps.prices.grossRoundedFromLinked` or `gaps.prices.netRoundedFromLinked`. When the entry is not linked, both prices were entered by hand, and a sub-cent value is refused, never rounded.

An offer whose price for the channel mode (gross or net) is missing or refused, or which has no tax after inheritance, is not created. Vendure 3.7.3 would store a null price as 0 and a missing tax category as its default one. `gaps.problems.refusedOffers` lists each such offer with its reasons, `load` records a failure for it, and a product none of whose offers can be created is not created either. Collections leave refused offers out and count them as `membersExcluded` in `load-result.json`. `verify` counts a refused offer as a missing variant, so it fails until the source data is fixed.

### load

Creates the model in Vendure through the Admin API, in dependency order: global settings (available languages), countries, zones, tax categories, tax rates, the default channel's settings (languages, currency, tax mode, default zones), assets, facets, products with option groups and variants, then collections. Collections get a variant-id filter with `inheritFilters` off, so a child category keeps exactly its own products.

An object whose dependency is not bound yet, for example a variant whose image failed to upload, is held back instead of being created without it. `load` records a failure, and the next run retries it once the dependency exists. A failure in the settings or channel step stops the load, since every later object depends on them. Any other failure is recorded per item and the load continues.

A facet or option group that was only partly created is completed on the next run: `load` reads back the values Vendure has, matches them by code, and creates only the missing ones.

Writes `load-journal.ndjson` and `load-result.json` (counts, timings, failures) in the snapshot, and `bindings.json` in `out/`.

Run it against an empty Vendure. `verify` compares total counts, so it only passes when Vendure held nothing else before the load.

### verify

Waits for Vendure's job queue to drain (up to `VERIFY_JOB_WAIT_MINUTES`; retrying jobs count as not drained), then checks:

- Total counts of products, variants, facets, facet values, collections, assets, countries, zones (tax zones plus the shipping zone), tax rates and search index entries against the model.
- Background jobs in state FAILED since the load started, or all failed jobs when the snapshot has no `load-result.json`.
- That no model offer is left without a tax category after inheritance.
- Every variant against its model offer: bound and present, SKU, product, option combination, enabled flag, stock, the tax category by bound id, and the price in the channel mode (`priceWithTax` against the gross price when the channel's prices include tax, `price` against the net price otherwise).
- The number of variants in each collection with members.
- The product name in every model language, for every product with a name authored in that language.

Writes `verify-report.json` and a readable `report.md` with the checks, the background jobs, the load failures, the gaps and the decisions. Both name the snapshot and the migrator's git commit (marked `+dirty` when `src/` has uncommitted changes); `verify-report.json` also records the start of the hash of every extract file. `verify` changes nothing in Vendure.

### oracle

Checks the migration against Shopware itself rather than against the migrator's own model:

- The Admin API with inheritance enabled returns Shopware's resolved base price, tax and active flag per variant. Any difference to the model means the migrator's inheritance rules are wrong. The Shopware price is converted to minor units by the same rule as in `transform`, so a linked sub-cent price that `transform` rounds is not a difference. The price check compares gross prices only, also in a channel with net prices. The report lists them under `resolver`, together with `missingInAdminApi` (offers the Admin API does not return) and `missingInVendure` (offers with no bound Vendure variant). `resolverMismatches` is the total of these lists.
- The Store API returns the name and the price a guest sees at quantity 1. The name is compared with Vendure. The guest price is compared with the Vendure price; the report counts equal and different prices, which side is higher, and the largest and summed differences. This measures the effect of the rule-price gap.
- For products with rule prices it works out which rule set the guest price and tests whether ordering rules by priority, then by id, predicts that choice. The winners are tallied by rule id.

Writes `oracle-report.json`, which also records the time of the measurement and its weekday in the Europe/Berlin time zone, since rules can depend on the day. It needs the Shopware admin credentials and store access key from `.env.example`, and reads the `product_price` and `rule` tables from MySQL. It changes nothing in Shopware or Vendure.

## The binding table and re-runs

`out/bindings.json` maps each Shopware row to the Vendure object created from it. A key looks like `shopware|product|<source id>|variant`; the role at the end exists because one Shopware row can become several Vendure objects. `load` skips every source row that already has a binding, so running it again after a failure continues where it stopped instead of creating duplicates. The file is shared by all snapshots.

`bindings.json` and every journal line record the Admin API URL they were written for. Ids from one Vendure mean nothing in another, so `load`, `verify` and `oracle` refuse to run when `VENDURE_ADMIN_API` differs. Use a separate `MIGRATOR_OUT_DIR` per target. A `bindings.json` from before the URL was recorded is adopted for the current URL.

Bindings are written to `bindings.json` in batches of 100 and at the end of each step. Every create is also appended to the snapshot's `load-journal.ndjson` right after Vendure returns the new id. When `load` starts, it replays the journals of all snapshots, oldest first, on top of `bindings.json` and saves the result. Only timestamp-named snapshot folders count, the same rule as for the newest snapshot; the current snapshot's journal is always replayed last, also when `--snapshot` names a folder without a timestamp. A crash between two batches therefore loses no bindings. If the crash cut the last journal line in half, that line is dropped and cut from the file. A binding to an empty id is refused. `verify` and `oracle` replay the same journals read-only and write nothing back.

To start over, empty Vendure and delete `bindings.json` together with the `load-journal.ndjson` files. Deleting only one of them brings back bindings to objects that no longer exist, or loses bindings to objects that do.

## Known limits

- Create and skip only. A bound object is never updated, so changes made in Shopware after the first load do not reach Vendure. Re-running `load` only creates what is still missing.
- A crash after Vendure created an object but before its journal line was written leaves that object without a binding. The next run creates it again. This affects only the requests in flight at that moment: up to four at once for assets and for products, and one variant request covers all missing variants of a product.
- Collections from product-stream (dynamic) categories are created empty. Link categories are skipped, and their children move to the top level.
- Vendure has channel membership, not visibility levels. Products with Shopware visibility 10 (hidden from listings and search) or 20 (hidden from listings) become normal, fully listed products, and so do products that are not visible in the storefront at all. `gaps.json` counts them.
- A variant with its own properties gets them as variant facet values next to the product's. Shopware replaces the parent's properties in that case; Vendure shows both.
- Only the default currency is migrated. Shopware derives the other currencies at runtime from a factor, and per-product prices in other currencies are ignored.
- Only the first active storefront sales channel, in id order, is read. Its countries, visibility, SEO URLs, navigation root and customer group price display are used.
- Only tax rules of type "entire country" are applied. Other rule types are counted in `gaps.json`.
- When every country has a tax rule that differs from the default rates, no zone matches the default rates, and `load` stops at the channel step.
- Only the locales en-GB, en-US, de-DE, de-AT and de-CH are mapped to Vendure language codes. A language's content locale is its translation code, else its locale. `transform` stops with an error for any other locale; extend `LOCALE_TO_LANGUAGE` in `src/transform/languages.mjs`. When several Shopware languages map to one code (en-GB and en-US both become `en`), the system language wins, then a language without parent language, then the lowest id. The others are dropped, and `gaps.languages` counts their translation rows.
- `category.visible = false` (hidden from navigation) has no Vendure field. It is kept in the model only.
- The "closeout" flag and configurator price overrides are counted in `gaps.json` but not applied.

## Code layout

- `src/cli.mjs`: parses the stage and `--snapshot`, runs the stages, sets the exit code.
- `src/config.mjs`: reads and validates every environment variable, finds snapshot folders, holds Shopware's constant ids.
- `src/extract.mjs`: the SQL queries and the consistent-snapshot read.
- `src/transform.mjs`: reads the snapshot, runs the builders in `src/transform/` and writes their output.
- `src/transform/languages.mjs`: Shopware languages to Vendure codes, dropped languages, translation helpers.
- `src/transform/tax.mjs`: storefront choice, countries, tax categories and tax zones.
- `src/transform/prices.mjs`: currency decimals and the gross and net price of an offer.
- `src/transform/products.mjs`: products, variants, inheritance, variant names, refused offers.
- `src/transform/facets.mjs`: property groups and manufacturers as facets.
- `src/transform/collections.mjs`: category order, collections, membership and the category index gap.
- `src/transform/assets.mjs`: product media as assets.
- `src/transform/slugs.mjs`: slugs from SEO paths or names, unique per language.
- `src/transform/redirects.mjs`: SEO URLs to redirects and `redirects.csv`.
- `src/transform/gaps.mjs`: the content of `gaps.json`.
- `src/load.mjs`: runs the load steps and writes `load-result.json`.
- `src/load/steps.mjs`: the load steps in dependency order; products live in their own module.
- `src/load/products.mjs`: products, option groups and variants.
- `src/load/context.mjs`: shared load state, dependency lookups that hold back dependent objects, offer refusal, matching by code.
- `src/verify.mjs`: the verify checks and `report.md`.
- `src/oracle.mjs`: the comparison with Shopware's Admin API, Store API and rule prices.
- `src/lib/resolve.mjs`: pure rules for inheritance, translation fallback, tax rules in force and tax zones.
- `src/lib/snapshot.mjs`: the snapshot format and the manifest check transform runs.
- `src/lib/bindings.mjs`: the binding table, its journals and the target URL check.
- `src/lib/http.mjs`: HTTP requests with timeout and bounded retries.
- `src/lib/vendure-client.mjs`: Vendure Admin API login, GraphQL calls and asset upload.
- `src/lib/util.mjs`: JSON files, hashes, slugs, minor units, CSV and logging.

## Tests

```sh
npm test
```

The tests use `node:test` and need no database or server; Vendure, Shopware and MySQL are stubbed where a stage needs them.

- `test/bindings.test.mjs`: crash recovery through the journal, torn journal lines, replay order across snapshots, that only timestamp-named snapshot folders are replayed, read-only opens, serialized flushes, empty ids, and the recorded target URL.
- `test/client-http.test.mjs`: timeouts, status in errors, bounded retries, and that queries retry while mutations and asset uploads do not.
- `test/config-load.test.mjs`: credentials per stage, empty values, number and URL validation, that `.env.example` lists every variable, and the snapshot folder rules.
- `test/load-dependencies.test.mjs`: missing dependencies hold back dependent objects, offers without price or tax are refused, the variant price follows the channel mode, and partly created option groups and facets are completed without duplicates.
- `test/resolve.test.mjs`: scalar and association inheritance, the language chain, language-major translation fallback, tax zones and the tax rules in force.
- `test/transform-collections.test.mjs`: category order from the sibling chain, link categories, membership from the listing index, and the category index gap.
- `test/transform-facets.test.mjs`: names of the manufacturer facet per shop language.
- `test/transform-input.test.mjs`: transform refuses a snapshot without manifest, in an old format, with a missing table or file, or with a changed file.
- `test/transform-languages.test.mjs`: which language wins a shared code, translation code before locale, and the gap for dropped languages.
- `test/transform-prices.test.mjs`: gross and net from the price JSON, rounding of linked sub-cent prices, refusal of unlinked ones, and currency decimals.
- `test/transform-products.test.mjs`: variant names, prices and refused offers per channel mode, and inheritance of media, cover, visibility and listing categories.
- `test/transform-redirects.test.mjs`: redirects for products, variants, categories and languages without own slug, unique slugs, and CSV quoting.
- `test/transform-tax.test.mjs`: which storefront sales channel is migrated.
- `test/util.test.mjs`: `toMinorUnits`, half-up rounding, `toCsv`, `slugify`, and that `log` writes to stdout and `logError` to stderr.
- `test/verify-compare.test.mjs`: the variant, membership and name comparisons, the job queue wait, failed jobs since the load, and one full verify run that leaves the bindings untouched.
- `test/verify-oracle.test.mjs`: oracle counts variants missing in Vendure, tallies rule winners by id, and converts a linked sub-cent Shopware price by the transform rule.
