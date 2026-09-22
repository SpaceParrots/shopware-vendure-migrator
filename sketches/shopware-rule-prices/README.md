> This is a sketch that was never run. It is not part of the migrator and nothing in `src/` imports it.

# Shopware rule prices in Vendure: sketch, not built

Status: **sketch**. Type-checked against `@vendure/core` 3.7.3, never registered in `vendure-config.ts`, never run, no tests. It exists to show which parts an implementation needs and how each could work. Every `TODO(build)` marks work that is deliberately not done.

## The gap

Shopware stores tier prices per product and **rule** in `product_price` (`product_id`, `rule_id`, `quantity_start`, `quantity_end`, `price` JSON keyed by currency with net and gross). A rule is a condition tree in `rule_condition`. At runtime Shopware evaluates every rule against the current customer and cart, and the first matching rule that has prices for the product sets the price.

Vendure has no rule engine. `ProductVariantPrice` holds one price per variant, channel and currency. Anything conditional has to be written as a price calculation strategy. So the catalogue import migrates the **base** price (`product.price`) and reports the rule prices as not migrated.

Measured in the dockware 6.7.0.0 source: 6,198 `product_price` rows across 12 rules, tiers from quantity 1 to 10 or 11, on 976 simple products, 525 variants and 25 parents.

## How Shopware actually picks a price

Read from `v6.7.14.1` source, not from docs:

1. `RuleLoader` loads all rules ordered by `priority DESC, id ASC`.
2. `CartRuleLoader` keeps the ones matching the current cart and customer, preserving that order, and re-evaluates until the set is stable, because prices change cart totals and cart totals change which rules match.
3. `ProductPriceCalculator::filterRulePrices` walks the matched rule IDs in order and takes the **first rule that has prices for this product**. Not the cheapest.
4. Within that rule, prices are sorted by `quantity_start` and the tier covering the line quantity applies.
5. No matching rule with prices means the product's base `price` applies.

Trap worth naming in the guide: when priorities tie, the winner is decided by the **binary UUID order** of the rule IDs. In the demo shop 7 of 12 rules share priority 100, including "Always valid" and two cart-amount-at-least-zero rules that match every cart. For most products the price customers see is therefore decided by which of those seven sorts first by ID. The resolver below reproduces that order on purpose, so a migrated shop can prove parity before anyone decides to simplify it.

## The parts

| #   | Part                            | Where in the sketch                          | Effort driver                                                                                      |
| --- | ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Store rules and rule prices     | `ShopwareRule`, `ShopwareRulePrice` entities | small                                                                                              |
| 2   | Evaluate conditions             | `conditionEvaluators` registry               | **one evaluator per condition type in use**; unknown types must fail the import, not pass silently |
| 3   | Collect the facts a rule needs  | `RuleFactsProvider`                          | customer groups, billing country, shop-local weekday, cart                                         |
| 4   | Pick the price the Shopware way | `RulePriceResolver`                          | tie-break, tiers, inheritance, fallback                                                            |
| 5   | Catalogue price                 | `ShopwareRuleCatalogPriceStrategy`           | batching; it runs for every variant in a listing                                                   |
| 6   | Cart price                      | `ShopwareRuleOrderItemPriceStrategy`         | the cart-amount circularity                                                                        |
| 7   | Wiring                          | `ShopwareRulePricesPlugin`                   | trivial                                                                                            |
| 8   | Import                          | `importRulePrices` (migrator step)           | resolve parent inheritance of `prices`, convert money to minor units                               |
| 9   | Parity proof                    | `parityFixtures`                             | record Shopware Store API prices per context, compare                                              |

Condition types used by the 12 demo rules: `alwaysValid`, `customerCustomerGroup`, `customerBillingCountry`, `dayOfWeek`, `cartCartAmount`, `cartLineItemProductStates`, plus the `andContainer` and `orContainer` wrappers. A real shop has to run the same inventory query first; Shopware core ships many more condition types, and plugins add their own.

## Known deviations to decide, not to discover

- **Cart-amount circularity.** Shopware loops until the rule set is stable. Vendure calls the order item strategy per line, while the order is being recalculated. The sketch evaluates cart conditions against the order totals from _before_ this recalculation. That can differ from Shopware for a cart that crosses a threshold. Options: accept and document it, or run a second recalculation pass when the matched rule set changes.
- **Weekday.** `dayOfWeek` has to be evaluated in the shop's timezone, not the server's.
- **Catalogue vs cart.** Shopware evaluates listing prices against the current, possibly empty, cart. The sketch treats a missing order as an empty cart with amount 0, which is what makes the at-least-zero rules match in listings too.
- **Simplify instead?** Collapsing rules into flat per-channel prices or customer-group price lists is legitimate, but it is a documented business decision, not a migration outcome.
