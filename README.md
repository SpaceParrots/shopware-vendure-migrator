# Shopware 6 to Vendure 3 catalogue migrator

A command-line tool that copies the product catalogue of a Shopware 6.7 shop into Vendure 3.7. It reads the Shopware database directly, resolves the values Shopware would show (variant inheritance, translation fallback, tax per country), writes an intermediate model to disk, and creates that model in Vendure through the Admin API. Two check stages then compare the result with the model and with Shopware's own APIs.

It was tested against Shopware 6.7.0.0 (the `dockware/dev` image with the demo-data plugin) and Vendure 3.7.3. Other versions may work, but the SQL in `src/extract.mjs` and the constants in `src/config.mjs` are written for 6.7.

The tool is experimental. It is meant to be read and adapted, not run unchanged against a production shop.

## What it migrates

- Products and variants. A Shopware parent with children becomes one Vendure product whose variants are the children. A product without children becomes a product with one variant.
- Base gross prices in the default currency, as integer minor units. Prices with sub-cent precision are refused and listed in `gaps.json`. Whether the channel shows prices with tax comes from the storefront's customer group.
- Tax categories, tax rates and zones. Countries with the same set of rates share one zone.
- Countries, languages and translations.
- Property groups as facets, and the options that define variants as product options. Manufacturers become values of one `manufacturer` facet.
- Categories as collections, in the same tree order.
- Product images and cover images.
- Slugs. Shopware SEO URLs are reused where they exist; `redirects.csv` lists each old path with its new slug.

## What it does not migrate

- Customers, orders and CMS layouts.
- Rule prices (Shopware's advanced prices). Only the base price is migrated. `transform` reports the rule prices in `gaps.json` with row and rule counts, and `oracle` measures how far the guest price in Shopware differs from the Vendure price. `sketches/shopware-rule-prices/` holds a sketch of a Vendure plugin that could close this gap. It was never run and is not part of the migrator. The text in `gaps.json` names the folder the sketch had in its original workspace; in this repository it is `sketches/shopware-rule-prices/`.
- Category media, manufacturer media and links, property option colours and media, cross-selling, product reviews, purchase and reference units, dimensions and weight.

`gaps.json` lists every gap with a count, so you can see what applies to your shop before deciding anything.

## Requirements

- Node.js 22.9 or later. No build step. The only dependency is `mysql2`.
- Read access to the Shopware MySQL database.
- HTTP access to the shop, so `load` can download product images.
- A Vendure 3.7 server with bearer tokens enabled (`authOptions.tokenMethod` includes `'bearer'`), an asset server and a search plugin, and an administrator account that can create catalogue entities.
- A running Vendure worker for `verify`, which waits for the job queue to drain.
- For `oracle` only: a Shopware admin user and the Store API access key of the storefront sales channel.

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env`. Every variable has a one-line comment in `.env.example`. The npm scripts load `.env` if it exists; variables already set in the shell take precedence. If you call `node src/cli.mjs` directly, set the variables yourself or pass `--env-file=.env`.

Every stage needs `SOURCE_DB_USER`, `SOURCE_DB_PASSWORD`, `VENDURE_USERNAME` and `VENDURE_PASSWORD` to be set, even `transform`, which connects to nothing. For an offline transform any placeholder value works.

## Running

```sh
npm run extract
npm run transform
npm run load
npm run verify
npm run oracle
```

`npm run all` runs extract, transform, load and verify in one go. `npm run help` prints the usage.

Each stage reads the files of the previous one, so a stage can be re-run on its own. All files go to `out/` (or `MIGRATOR_OUT_DIR`). `extract` and `all` create a new snapshot folder named after the current time, for example `out/snapshots/2026-09-21T19-14-34-278Z/`. The other stages use the newest snapshot unless you name one:

```sh
npm run transform -- --snapshot 2026-09-21T19-14-34-278Z
```

### extract

Reads the catalogue tables from MySQL in one read-only transaction with a consistent snapshot, so all files describe the same moment even while the shop takes orders. Only the live version of versioned rows is read.

Writes `raw/*.json` (one file per query) and `manifest.extract.json` (row counts, a SHA-256 hash per file, and the MySQL version and migration count of the source).

### transform

Reads only `raw/` and writes files, so it runs offline. For the same snapshot and the same `SOURCE_MEDIA_BASE_URL` it writes the same files, apart from the `generatedAt` timestamp in `model.json`. It resolves the effective value of every field the way Shopware does: a variant's NULL field inherits the parent's value; a variant with no categories or properties of its own inherits the parent's list; translations fall back along the language chain (requested language, its parent language, the system language), first on the variant and then on the parent.

Writes:

- `model.json`: the intermediate model that `load` creates in Vendure, plus the expected counts that `verify` checks.
- `decisions.json`: each mapping choice in plain text, for example how variants are named or how tax zones are formed.
- `gaps.json`: what is not migrated, with counts, and data problems such as prices with sub-cent precision.
- `diagnostics.json`: how many values came from the parent product, per field.
- `redirects.csv`: old Shopware SEO path and new slug per product and category.

The pure rules behind this live in `src/lib/resolve.mjs` and are covered by the tests in `test/`.

### load

Creates the model in Vendure through the Admin API, in dependency order: global settings, countries, zones, tax categories, tax rates, the default channel's settings, assets, facets, products with option groups and variants, then collections. Collections get a variant-id filter with `inheritFilters` off, so a child category keeps exactly its own products.

Writes `load-journal.ndjson` and `load-result.json` (counts, timings, failures) in the snapshot, and `bindings.json` in `out/`.

Run it against an empty Vendure. `verify` compares total counts, so it only passes when Vendure held nothing else before the load.

### verify

Waits for Vendure's job queue to drain (up to `VERIFY_JOB_WAIT_MINUTES`), then checks:

- Total counts of products, variants, facets, facet values, collections, assets, countries, zones, tax rates and search index entries against the model.
- Every variant field by field: SKU, product, price, tax category, options, enabled flag and stock.
- The number of variants in each collection.
- The German name of every product that has one.

Writes `verify-report.json` and a readable `report.md` with the checks, the gaps and the decisions. Both name the snapshot and the migrator's git commit; `verify-report.json` also records the hash of every extract file.

### oracle

Checks the migration against Shopware itself rather than against the migrator's own model:

- The Admin API with inheritance enabled returns Shopware's resolved base price, tax and active flag per variant. Any difference to the model means the migrator's inheritance rules are wrong.
- The Store API returns the name and the price a guest sees. The name is compared with Vendure. The price difference measures the effect of the rule-price gap.
- For products with rule prices it works out which rule set the guest price and tests whether ordering rules by priority, then by id, predicts that choice.

Writes `oracle-report.json`. It needs the Shopware admin credentials and store access key from `.env.example`, and reads the `product_price` and `rule` tables from MySQL.

## The binding table and re-runs

`out/bindings.json` maps each Shopware row to the Vendure object created from it. A key looks like `shopware|product|<source id>|variant`; the role at the end exists because one Shopware row can become several Vendure objects. `load` skips every source row that already has a binding, so running it again after a failure continues where it stopped instead of creating duplicates. The file is shared by all snapshots.

Bindings are written to `bindings.json` in batches of 100 and at the end of each step. Every create is also appended to the snapshot's `load-journal.ndjson` right after Vendure returns the new id. When `load` starts, it replays the journals of all snapshots, oldest first, on top of `bindings.json` and saves the result. A crash between two batches therefore loses no bindings. If the crash cut the last journal line in half, that line is dropped and cut from the file.

To start over, empty Vendure and delete `bindings.json` together with the `load-journal.ndjson` files. Deleting only one of them brings back bindings to objects that no longer exist, or loses bindings to objects that do.

## Known limits

- Create and skip only. A bound object is never updated, so changes made in Shopware after the first load do not reach Vendure. Re-running `load` only creates what is still missing.
- A crash after Vendure created an object but before its journal line was written leaves that object without a binding. The next run creates it again. This affects only the requests in flight at that moment: up to four at once for assets and for products, and one variant request covers all missing variants of a product.
- Collections from product-stream (dynamic) categories are created empty. Link categories are skipped, and their children move to the top level.
- Vendure has channel membership, not visibility levels. Products with Shopware visibility 10 (hidden from listings and search) or 20 (hidden from listings) become normal, fully listed products, and so do products that are not visible in the storefront at all. `gaps.json` counts them.
- Only the default currency is migrated. Shopware derives the other currencies at runtime from a factor, and per-product prices in other currencies are ignored.
- Only the first storefront sales channel is read. Its countries, visibility and SEO URLs are used.
- Only tax rules of type "entire country" are applied. Other rule types are counted in `gaps.json`.
- Only the locales en-GB, en-US, de-DE, de-AT and de-CH are mapped to Vendure language codes. `transform` stops with an error for any other locale; extend `LOCALE_TO_LANGUAGE` in `src/transform.mjs`.
- `category.visible = false` (hidden from navigation) has no Vendure field. It is kept in the model only.
- The "closeout" flag and configurator price overrides are counted in `gaps.json` but not applied.

## Tests

```sh
npm test
```

The tests use `node:test` and need no database or server. They cover the resolvers in `src/lib/resolve.mjs`, `toMinorUnits` and `slugify`, and crash recovery of the binding table.
