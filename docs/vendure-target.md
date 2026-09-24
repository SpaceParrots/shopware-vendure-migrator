# Preparing the Vendure target

The migrator writes into a Vendure 3.7 server you run yourself. Start from an **empty database**: `verify` compares total counts, so it only passes when Vendure held nothing else before the load.

## Catalogue stages

- **Bearer tokens.** `authOptions.tokenMethod` must include `'bearer'`; the migrator logs in through the Admin API and sends the token.
- **An administrator** who can change the global settings and the default channel and create catalogue entities. The superadmin works.
- **An asset server**, for example `AssetServerPlugin`, so `load` can upload product images.
- **A search plugin**, for example `DefaultSearchPlugin`. `verify` checks that every variant is in the search index.
- **A running worker** with a job queue, for example `DefaultJobQueuePlugin`. `verify` waits for the queue to drain and fails on jobs that failed since the load.

## Customer and order stages

`load-sales` boots Vendure in-process from `VENDURE_CONFIG` and writes through its database connection. The config it loads must be the one the server runs with, and it needs:

- **Custom fields**, all `string` and nullable:
  - `Customer.shopwareId`, `Customer.customerNumber`
  - `Order.shopwareId`, `Order.shopwareStates`
  - `OrderLine.shopwareLineType`, `OrderLine.legacyLabel`, `OrderLine.legacyProductNumber`
- **A `MoneyStrategy` that rounds a half away from zero**, like PHP's `round()`. Vendure's default uses `Math.round`, which takes -16.745 to -16.74 where Shopware has -16.75.
- **The default `OrderTaxCalculationStrategy`** (tax per line total, like Shopware's "horizontal" calculation). `OrderLevelTaxCalculationStrategy` rounds once per rate and matched Shopware on far fewer orders.
- The `manual-fulfillment` handler and the default shipping eligibility checker and calculator, which Vendure ships with.

## Example config

The parts the migrator depends on, in a CommonJS `vendure-config.js`. Fill in your own database and secrets.

```js
const path = require('node:path');
const {
    DefaultJobQueuePlugin, DefaultMoneyStrategy, DefaultOrderTaxCalculationStrategy, DefaultSearchPlugin,
} = require('@vendure/core');
const { AssetServerPlugin } = require('@vendure/asset-server-plugin');

/** DefaultMoneyStrategy with PHP's rounding: multiply, then round a half away from zero. */
class HalfAwayFromZeroMoneyStrategy extends DefaultMoneyStrategy {
    round(value, quantity = 1) {
        const v = value * quantity;
        return Math.sign(v) * Math.round(Math.abs(v));
    }
}

// Where Shopware data has no core field. Read-only in the dashboard: they record the source.
const legacy = name => ({ name, type: 'string', readonly: true, nullable: true });

const config = {
    apiOptions: { port: 3000, adminApiPath: 'admin-api', shopApiPath: 'shop-api' },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: { identifier: process.env.SUPERADMIN_USER, password: process.env.SUPERADMIN_PASSWORD },
        cookieOptions: { secret: process.env.COOKIE_SECRET },
    },
    dbConnectionOptions: { /* your database */ },
    paymentOptions: { paymentMethodHandlers: [] },
    taxOptions: { orderTaxCalculationStrategy: new DefaultOrderTaxCalculationStrategy() },
    entityOptions: { moneyStrategy: new HalfAwayFromZeroMoneyStrategy() },
    customFields: {
        Customer: [legacy('shopwareId'), legacy('customerNumber')],
        Order: [legacy('shopwareId'), legacy('shopwareStates')],
        OrderLine: [legacy('shopwareLineType'), legacy('legacyLabel'), legacy('legacyProductNumber')],
    },
    plugins: [
        AssetServerPlugin.init({ route: 'assets', assetUploadDir: path.join(__dirname, '../static/assets') }),
        DefaultJobQueuePlugin.init({}),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
    ],
};

module.exports = { config };
```

Custom fields change the database schema, so add them before the first start, or generate a migration for them.

## After the migration

- Payment methods and real shipping rules are not migrated. `load-sales` creates one shipping method per Shopware method for the historical orders to point at; they carry an eligibility checker no order can pass, so they never appear at checkout. Set up the shipping and payment methods you actually use yourself.
- Everything is created in the default channel.
