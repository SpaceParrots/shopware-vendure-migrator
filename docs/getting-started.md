# Getting started

## Requirements

- **Node.js 22.9 or later.** No build step. The only runtime dependency is `mysql2`.
- **Shopware 6.7** with read access to its MySQL database, and HTTP access to the shop so `load` can download product images. Tested with 6.7.0.0 (`dockware/dev` with the demo-data plugin) and 6.7.14.2 (`shopware/docker-dev` with `framework:demodata`).
- **Vendure 3.7** (tested with 3.7.3), prepared as described in [Preparing the Vendure target](vendure-target.md), with a running worker. Start with an empty database: `verify` compares total counts.
- For `oracle` only: a Shopware admin user and the Store API access key of the storefront sales channel.
- For `load-sales` only: the migrator must be able to `require()` the Vendure server's config module and its `@vendure/core`, so run it on a machine that has the Vendure project checked out and installed.

Other versions may work, but the SQL in `src/extract.mjs` and the constants in `src/config.mjs` are written for Shopware 6.7.

> The tool is experimental. It is meant to be read and adapted, not run unchanged against a production shop. Migrate a copy of the shop's database into a fresh Vendure first.

## Install

```sh
git clone https://github.com/SpaceParrots/shopware-vendure-migrator.git
cd shopware-vendure-migrator
npm install
cp .env.example .env
```

Edit `.env`. Every variable has a one-line comment there; [Configuration](configuration.md) has the full table. At minimum set the source database credentials, `SOURCE_MEDIA_BASE_URL`, `VENDURE_ADMIN_API` and the Vendure administrator.

## Refresh Shopware's indexes

Collection membership comes from Shopware's `product_category_tree` index. If the shop was imported or edited in bulk, refresh it first, and repeat until `gaps.categoryIndex.collectionsLosingMembers` in `gaps.json` is 0 (see [Catalogue migration](catalogue.md#transform)):

```sh
bin/console dal:refresh:index
```

## Migrate the catalogue

```sh
npm run extract     # MySQL -> out/snapshots/<timestamp>/raw/*.json
npm run transform   # raw -> model.json, gaps.json, decisions.json, redirects.csv
npm run load        # model.json -> Vendure Admin API
npm run verify      # Vendure vs. model.json -> report.md
```

`npm run all` runs these four in one go. Read `report.md` in the snapshot folder when it is done. Exit code 1 means a stage threw, `load` recorded failures, or `verify` has a failed check.

Optionally compare with Shopware's own APIs:

```sh
npm run oracle      # -> oracle-report.json
```

## Migrate customers and orders

After the catalogue is loaded, on the same snapshot:

```sh
npm run transform-sales
npm run load-sales        # needs VENDURE_CONFIG
npm run verify-sales
```

See [Customers and orders](customers-and-orders.md).

## Re-running

Every stage reads the files of the previous one, so each can be re-run on its own. `load` and `load-sales` skip what they already created and retry what failed. To run a stage on an older snapshot:

```sh
npm run transform -- --snapshot 2026-09-21T19-14-34-278Z
```

`npm run help` prints the usage. To start over, see [Bindings and re-runs](bindings-and-reruns.md#starting-over).

## After the migration

- Put `redirects.csv` into your web server or storefront so old Shopware URLs keep working.
- Work through `gaps.json` and `sales-gaps.json`: every entry is something you decide on by hand.
- Delete the `out/` folder once you no longer need it. It contains customer data and password hashes; see [SECURITY.md](../SECURITY.md).
