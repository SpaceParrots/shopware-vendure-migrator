# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org/) once it reaches 1.0; until then any minor version may change behaviour.

## [Unreleased]

### Added

- Order and customer history. `load-sales` writes Shopware's state history as Vendure history entries at Shopware's times: order state, payment, refund and fulfillment transitions, and customer registration and verification. `verify-sales` checks them against Shopware's MySQL. Snapshots extracted before this version lack the transitions' start states: extract again. Orders and customers loaded before are skipped as bound and get no history; load them into a fresh database.
- MIT license, contributing guide, security policy, code of conduct, CI workflow and issue templates.
- Documentation in `docs/`.

### Fixed

- `load-sales` no longer writes a customer without an unbound customer group, or an order without an unbound shipping method. The item fails, stays unbound, and the next run retries it; before, it was written incomplete and skipped forever.
- `--help` lists the sales stages under `--snapshot` and the exit code.
- The HTTP timeout test no longer gets cancelled on Node versions where the event loop empties before `AbortSignal.timeout()` fires.

## 0.1.0

First version.

- Catalogue migration: products and variants with Shopware's inheritance and translation fallback, base prices, stock, tax categories, rates and zones, countries, languages, facets, collections, assets, slugs and redirects.
- Customer and order history migration: customers with their bcrypt hashes, addresses and groups; orders as finished historical records with payments, refunds and fulfillments.
- `verify`, `verify-sales` and `oracle` checks against the model, Vendure and Shopware's own APIs.
