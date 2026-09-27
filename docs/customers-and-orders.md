# Customers and orders

Three stages carry customers and order history. They run after the catalogue is loaded, on a snapshot that `extract` wrote with the current version: the customer and order tables are read in the same consistent snapshot as the catalogue.

```sh
npm run transform-sales   # after transform, same snapshot
npm run load-sales        # after load
npm run verify-sales
```

The target Vendure needs custom fields, a money strategy and a tax strategy for these stages; see [Preparing the Vendure target](vendure-target.md#customer-and-order-stages).

## transform-sales

Reads the snapshot and writes `sales-model.json`, `sales-decisions.json` and `sales-gaps.json`. Like `transform`, it connects to nothing.

### Customers

- **One Vendure customer per email.** A registered account is the primary row of its email. Shopware's per-checkout guest rows with the same email become that customer, or the oldest guest.
- **Guests get no user.** Registered customers get a user with their Shopware bcrypt hash, prefix `$2y$` rewritten to `$2b$`: Node's `bcrypt` answers `false` for `$2y$` without an error, so an unconverted hash would fail every login silently. Shopware 5 legacy hashes and other schemes are not carried and are counted.
- **Carried:** addresses, customer groups, the customer number (custom field) and the Shopware id (custom field).
- **Counted in `sales-gaps.json`, not carried:** salutation, birthday, company, VAT ids and newsletter state.

### Orders

Orders are written as finished historical records:

- Shopware's order number as the code, its order date, line and discount amounts from the order's own price JSON, the customer and address snapshots, payments, full refunds and fulfillments.
- **States.** The three Shopware states (order, delivery, transaction) map through the table in `src/transform/order-states.mjs`. A combination it does not cover refuses the order. The original triple is kept in the custom field `shopwareStates`.
- **Non-product lines.** Promotion, credit and custom lines become surcharges, one per tax rate with Shopware's share.
- **Deleted products.** A product line without a Vendure variant (a deleted product, or a parent product Shopware sold itself) points at one disabled placeholder variant, "Archived Shopware product".
- **No side effects.** No stock movements, allocations, events or mails are created.

## load-sales

`load-sales` boots Vendure from `VENDURE_CONFIG`, without the job queue or an HTTP server, and writes through its TypeORM connection, one transaction per customer and per order. It creates, in order: customer groups, customers with users and addresses, one shipping method per Shopware method, the placeholder product, and the orders.

### Why in-process

The Admin API cannot do this:

- `createCustomer` always creates a user, publishes `AccountRegistrationEvent` and hashes a plain password. It cannot take an existing hash or create a guest.
- Draft orders reprice every line, stamp today's date and a new code, and allocate stock.

### Totals

Vendure's configured `OrderTaxCalculationStrategy` computes the stored order totals from the lines. Where that misses Shopware's invoice total, the invoice total is stored instead and listed in `load-sales-result.json` under `totalsFromInvoice`: Shopware computes a discount share's tax from the unrounded share, so a few orders differ by a cent, and the order total must equal the settled payment.

A difference of more than one minor unit per surcharge is treated as a mapping error: the order fails instead of the invoice hiding it.

### Failures and re-runs

Bindings, the journal and skip-if-bound work as in `load`; see [Bindings and re-runs](bindings-and-reruns.md). A customer whose customer group is not bound, or an order whose customer, variant or shipping method is not bound, is not written. The failure is listed in `load-sales-result.json`, and the next run retries it.

## verify-sales

Re-reads amounts, dates and emails from Shopware's MySQL, not from `sales-model.json`, so a transform bug cannot hide itself. It reads Vendure through its public APIs only. Expected states and counts do come from the model, because they are mapping decisions.

Checks:

| Check | What it compares |
|---|---|
| `customers.count` | Number of Vendure customers against the model. |
| `customers.fields` | Each model customer is in Vendure and still in Shopware, with the same email and names, a user exactly when registered, and for registered customers the number of addresses and one group. |
| `customers.mergedRowsHaveNoOwnCustomer` | Guest rows merged into another customer did not become customers of their own. |
| `orders.count`, `orders.noneActive` | Number of orders; none is left active (as an open cart). |
| `orders.totalsMatchShopware` | Gross and net totals against Shopware's MySQL. Also reports orders in Shopware that are not in the model (refused, or placed after the snapshot). |
| `orders.partsAddUpToTotal` | Lines, surcharges and shipping add up to the total, within one minor unit per surcharge. |
| `orders.taxPerRateWithinOneCentOfShopware` | Tax per rate, with one-cent deviations counted apart. |
| `orders.placedAtMatchesShopware`, `orders.customerMatchesShopware` | Order date and owner. |
| `orders.lineAndSurchargeCounts` | Number of lines and surcharges. |
| `orders.statesAsMapped` | Order, payment and fulfillment states against the mapping. |
| `orders.paymentsAndRefunds` | State and amount of the last payment, and the refunded total. |
| `orders.placeholderLines` | Number of lines pointing at the placeholder variant. |
| `stock.nothingAllocated` | The import allocated no stock. |
| `shop.loginAndOrderHistory`, `shop.wrongPasswordRefused` | Only with `VERIFY_LOGIN_PASSWORD`: every registered customer logs into the Shop API and sees their order history, and a wrong password is refused. |

Writes `verify-sales-report.json`. The exit code is 1 when a check fails.

## Preparing a demo shop

`framework:demodata` creates every order as open/open/open with only product and promotion lines. `scripts/source-scenarios.mjs` gives a demo shop the order history a real shop has: it moves orders through Shopware's own state machines, places guest orders through the Store API, creates admin orders with custom and credit lines, and deletes a few ordered products.

It **writes** to the shop. Run it once, against a throwaway demo shop only, before `extract`:

```sh
node --env-file=.env scripts/source-scenarios.mjs
```

It reads `SOURCE_MEDIA_BASE_URL`, `SOURCE_ADMIN_USER`, `SOURCE_ADMIN_PASSWORD` and `SOURCE_STORE_ACCESS_KEY`.
