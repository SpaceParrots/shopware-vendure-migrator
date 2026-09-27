# Architecture

## Data flow

```
                 Shopware MySQL
                       │ one read-only, consistent-snapshot transaction
                       ▼
extract ─────> raw/*.json + manifest.extract.json        (hash per file)
                       │ offline, deterministic
                       ▼
transform ───> model.json, gaps.json, decisions.json, diagnostics.json, redirects.csv
transform-sales ─> sales-model.json, sales-gaps.json, sales-decisions.json
                       │
                       ▼
load ────────> Vendure Admin API (GraphQL)       ┐
load-sales ──> Vendure in-process (TypeORM)      ├─> bindings.json + load-journal.ndjson
                       │                         ┘
                       ▼
verify, verify-sales, oracle ─> reports             (read-only)
```

Every stage reads files the previous one wrote, so each can be re-run on its own, and the intermediate files can be read, diffed and checked by hand.

## Design rules

The code follows a few rules consistently. A change should keep them.

- **Resolve like Shopware.** A value is migrated as Shopware would show it: inheritance, translation fallback and tax rules follow Shopware's own code, not its database columns. `oracle` exists to prove this against Shopware's APIs.
- **Refuse rather than guess.** When the source does not allow a correct result (a missing price, an unmapped order state, an unknown locale), the object is refused and reported, never filled with a plausible default. Vendure would otherwise store a null price as 0 or a missing tax category as its default one.
- **Every gap is counted.** Anything not migrated shows up in `gaps.json` or `sales-gaps.json` with a count, and every mapping choice in `decisions.json`.
- **References go through `need()`.** A reference to an object an earlier step created is looked up with `need()` (`src/load/context.mjs`). A missing binding holds the dependent object back and records a failure, so the next run creates it complete, instead of creating it without the reference and skipping it forever.
- **Never retry a create.** Only reads, logins and downloads retry (`src/lib/http.mjs`).
- **Verify independently.** `verify-sales` re-reads amounts from Shopware's MySQL rather than trusting `sales-model.json`; `oracle` compares with Shopware's APIs rather than the model.
- **Pure transforms.** Everything under `src/transform/` and `src/lib/resolve.mjs` is a pure function over plain rows. That is what makes it testable without a database.

## Code layout

**Entry and configuration**

- `src/cli.mjs`: parses the stage and `--snapshot`, runs the stages, sets the exit code.
- `src/config.mjs`: reads and validates every environment variable, finds snapshot folders, holds Shopware's constant ids.

**extract**

- `src/extract.mjs`: the catalogue SQL queries and the consistent-snapshot read.
- `src/extract/sales-queries.mjs`: the customer and order queries.

**transform**

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

**transform-sales**

- `src/transform-sales.mjs`: resolves customer identities and maps each order to a finished Vendure record.
- `src/transform/customers.mjs`: customers, users, addresses, guest merging, password hash conversion.
- `src/transform/orders.mjs`: orders, lines and surcharges from the order's own price JSON.
- `src/transform/order-states.mjs`: the table mapping Shopware's three state machines to Vendure states.
- `src/transform/order-history.mjs`: replays Shopware's state history through that table into Vendure history entries.

**load**

- `src/load.mjs`: runs the load steps and writes `load-result.json`.
- `src/load/steps.mjs`: the load steps in dependency order; products live in their own module.
- `src/load/products.mjs`: products, option groups and variants.
- `src/load/context.mjs`: shared load state, `need()` and the dependency lookups that hold back dependent objects, offer refusal, matching by code.
- `src/load-sales.mjs`: boots Vendure in-process and writes customers and orders.

**verify**

- `src/verify.mjs`: the catalogue checks and `report.md`.
- `src/verify-sales.mjs`: the customer and order checks.
- `src/oracle.mjs`: the comparison with Shopware's Admin API, Store API and rule prices.

**Shared**

- `src/lib/resolve.mjs`: pure rules for inheritance, translation fallback, tax rules in force and tax zones.
- `src/lib/snapshot.mjs`: the snapshot format and the manifest check transform runs.
- `src/lib/bindings.mjs`: the binding table, its journals and the target URL check.
- `src/lib/http.mjs`: HTTP requests with timeout and bounded retries.
- `src/lib/vendure-client.mjs`: Vendure Admin API login, GraphQL calls and asset upload.
- `src/lib/util.mjs`: JSON files, hashes, slugs, minor units, CSV and logging.

**Outside `src/`**

- `scripts/source-scenarios.mjs`: prepares a demo shop with a realistic order history. Writes to the shop.
- `sketches/shopware-rule-prices/`: a never-run sketch of a Vendure plugin for Shopware's rule prices.

## Adapting it

The most likely changes for another shop:

- **Another locale:** extend `LOCALE_TO_LANGUAGE` in `src/transform/languages.mjs`.
- **Another Shopware version:** check the queries in `src/extract.mjs` and `src/extract/sales-queries.mjs` against the schema, and the constant ids in `src/config.mjs`. Bump the snapshot format in `src/lib/snapshot.mjs` when the raw files change shape.
- **An unmapped order state combination:** add a rule to `src/transform/order-states.mjs`.
- **A field that is not migrated:** add it to the query, carry it in the builder, create it in the load step, and add a verify check. Remove its entry from `gaps.json`.
