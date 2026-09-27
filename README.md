# Shopware 6 to Vendure 3 migrator

[![CI](https://github.com/SpaceParrots/shopware-vendure-migrator/actions/workflows/ci.yml/badge.svg)](https://github.com/SpaceParrots/shopware-vendure-migrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A command-line tool that copies the product catalogue of a Shopware 6.7 shop into Vendure 3.7, and then its customers and order history.

It reads the Shopware database directly, resolves the values Shopware would show (variant inheritance, translation fallback, tax per country), writes an intermediate model to disk, and creates that model in Vendure. Check stages then compare the result with the model, with Shopware's database and with Shopware's own APIs.

Tested against Shopware 6.7.0.0 and 6.7.14.2 and Vendure 3.7.3.

> **Status: experimental.** The tool is meant to be read and adapted, not run unchanged against a production shop. Migrate a copy of the shop into a fresh Vendure first, and read what it does not migrate.

## Why this tool

- **It resolves like Shopware.** A variant's price, tax, name and images are what the storefront shows, not what its database row holds. `oracle` proves it against Shopware's Admin and Store API.
- **It refuses rather than guesses.** An offer without a price, an unknown order state or an unmapped locale is refused and reported, never filled with a plausible default.
- **It tells you what is missing.** `gaps.json` counts everything not migrated for your shop; `decisions.json` explains every mapping choice.
- **It can be re-run.** A binding table and a journal remember what was created, so a failed load continues where it stopped, without duplicates.
- **Orders stay historical.** Customers keep their passwords, orders keep their number, date, amounts and states, and nothing allocates stock or sends a mail.

## What it migrates

| | |
|---|---|
| **Catalogue** | Products and variants, base prices, stock, tax categories, rates and zones, countries, languages and translations, facets from properties and manufacturers, collections from categories, product images, slugs and a redirect list. |
| **Customers** | One customer per email with addresses, groups and their bcrypt password hash; guests merged. |
| **Orders** | Finished historical records with lines, discounts and surcharges, shipping, payments, full refunds and fulfillments. |

Not migrated, among others: CMS layouts, rule (advanced) prices, list prices, documents, partial refunds, reviews, cross-selling. See [Coverage and limits](docs/coverage-and-limits.md).

## Quick start

Requires Node.js 22.9 or later, read access to the Shopware MySQL database, and a Vendure 3.7 server prepared as in [Preparing the Vendure target](docs/vendure-target.md).

```sh
npm install
cp .env.example .env      # fill in credentials and URLs

npm run extract           # Shopware MySQL -> out/snapshots/<timestamp>/raw
npm run transform         # -> model.json, gaps.json, decisions.json, redirects.csv
npm run load              # -> Vendure Admin API
npm run verify            # -> report.md

npm run transform-sales   # customers and orders, same snapshot
npm run load-sales
npm run verify-sales
```

`npm run all` runs extract, transform, load and verify in one go; `npm run help` prints the usage.

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Preparing the Vendure target](docs/vendure-target.md)
- [Catalogue migration](docs/catalogue.md): extract, transform, prices, load, verify, oracle
- [Customers and orders](docs/customers-and-orders.md)
- [Bindings and re-runs](docs/bindings-and-reruns.md)
- [Coverage and limits](docs/coverage-and-limits.md)
- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)

## Security

The output folder contains the shop's data, and after the sales stages customer data and password hashes. Treat it like a database dump. See [SECURITY.md](SECURITY.md), which also explains how to report a vulnerability.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; this project follows a [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © SpaceParrots
