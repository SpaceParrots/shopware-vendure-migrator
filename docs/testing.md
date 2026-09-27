# Testing

## Unit and integration tests

```sh
npm test
```

The tests use `node:test` and need no database or server; Vendure, Shopware and MySQL are stubbed where a stage needs them. CI runs them on Linux and Windows with Node 22 and 24.

| File | Covers |
|---|---|
| `test/bindings.test.mjs` | Crash recovery through the journal, torn journal lines, replay order across snapshots, that only timestamp-named snapshot folders are replayed, read-only opens, serialized flushes, empty ids, and the recorded target URL. |
| `test/client-http.test.mjs` | Timeouts, status in errors, bounded retries, and that queries retry while mutations and asset uploads do not. |
| `test/config-load.test.mjs` | Credentials per stage, empty values, number and URL validation, that `.env.example` lists every variable, and the snapshot folder rules. |
| `test/load-dependencies.test.mjs` | Missing dependencies hold back dependent objects, offers without price or tax are refused, the variant price follows the channel mode, and partly created option groups and facets are completed without duplicates. |
| `test/load-sales-refs.test.mjs` | An unbound customer group or shipping method holds back the customer or order. |
| `test/resolve.test.mjs` | Scalar and association inheritance, the language chain, language-major translation fallback, tax zones and the tax rules in force. |
| `test/transform-collections.test.mjs` | Category order from the sibling chain, link categories, membership from the listing index, and the category index gap. |
| `test/transform-facets.test.mjs` | Names of the manufacturer facet per shop language. |
| `test/transform-input.test.mjs` | transform refuses a snapshot without manifest, in an old format, with a missing table or file, or with a changed file. |
| `test/transform-languages.test.mjs` | Which language wins a shared code, translation code before locale, and the gap for dropped languages. |
| `test/transform-prices.test.mjs` | Gross and net from the price JSON, rounding of linked sub-cent prices, refusal of unlinked ones, and currency decimals. |
| `test/transform-products.test.mjs` | Variant names, prices and refused offers per channel mode, and inheritance of media, cover, visibility and listing categories. |
| `test/transform-redirects.test.mjs` | Redirects for products, variants, categories and languages without own slug, unique slugs, and CSV quoting. |
| `test/transform-sales.test.mjs` | Who becomes which Vendure customer, which password hashes still log in, how three Shopware states become one Vendure state, and where every cent of an order goes. |
| `test/transform-tax.test.mjs` | Which storefront sales channel is migrated. |
| `test/util.test.mjs` | `toMinorUnits`, half-up rounding, `toCsv`, `slugify`, and that `log` writes to stdout and `logError` to stderr. |
| `test/verify-compare.test.mjs` | The variant, membership and name comparisons, the job queue wait, failed jobs since the load, and one full verify run that leaves the bindings untouched. |
| `test/verify-oracle.test.mjs` | Oracle counts variants missing in Vendure, tallies rule winners by id, converts a linked sub-cent Shopware price by the transform rule, compares base, guest and rule prices in the channel mode, and counts refused offers apart from the resolver mismatches. |

`load-sales` writes through Vendure's own entities and is covered by the end-to-end run below, not by unit tests; only its reference lookups are unit-tested.

## End-to-end run

The stages themselves are the end-to-end test: `verify`, `verify-sales` and `oracle` check the result against the model, Shopware's database and Shopware's APIs.

1. Start a Shopware 6.7 demo shop, for example the `dockware/dev` image with the demo-data plugin, or `shopware/docker-dev` with `bin/console framework:demodata`.
2. Optionally give it a realistic order history with `node --env-file=.env scripts/source-scenarios.mjs`. **This writes to the shop.**
3. Start an empty Vendure 3.7 server and worker configured as in [Preparing the Vendure target](vendure-target.md).
4. Run the stages:

   ```sh
   npm run all
   npm run oracle
   npm run transform-sales
   npm run load-sales
   VERIFY_LOGIN_PASSWORD=<demo password> npm run verify-sales
   ```

5. Every command should exit with 0. Read `report.md`, `oracle-report.json` and `verify-sales-report.json` in the snapshot folder.

Run `npm run load` a second time to check that a re-run creates no duplicates: the `created` counts of assets, products, variants and collections in `load-result.json` should be 0.
