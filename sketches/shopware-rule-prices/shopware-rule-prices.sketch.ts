/**
 * SKETCH - not registered, not run, not tested. See README.md in this folder.
 *
 * Shows the parts needed to reproduce Shopware 6 rule-based tier prices in Vendure 3.x.
 * Every `TODO(build)` is deliberately left undone.
 */
import {
  Customer,
  DeepPartial,
  ID,
  Injector,
  Order,
  OrderItemPriceCalculationStrategy,
  PluginCommonModule,
  PriceCalculationResult,
  ProductVariant,
  ProductVariantPriceCalculationArgs,
  ProductVariantPriceCalculationStrategy,
  RequestContext,
  RequestContextCacheService,
  TransactionalConnection,
  VendureEntity,
  VendurePlugin,
} from "@vendure/core";
import { Column, Entity, Index, ManyToOne } from "typeorm";

// ---------------------------------------------------------------------------
// Part 1: storage. Rules and rule prices live in their own tables, because
// ProductVariantPrice holds exactly one price per variant, channel and currency.
// ---------------------------------------------------------------------------

/** A condition node as stored in Shopware's rule_condition, rebuilt into a tree. */
export interface RuleConditionNode {
  type: string; // e.g. 'andContainer', 'customerCustomerGroup', 'cartCartAmount'
  value: Record<string, unknown>; // rule_condition.value JSON, verbatim
  children: RuleConditionNode[];
}

@Entity()
export class ShopwareRule extends VendureEntity {
  constructor(input?: DeepPartial<ShopwareRule>) {
    super(input);
  }

  @Column() name: string;

  /** rule.priority. Higher wins. */
  @Column() priority: number;

  /**
   * rule.id as lowercase hex. Kept because Shopware breaks priority ties by
   * `id ASC`, and parity requires the same order.
   */
  @Index({ unique: true })
  @Column()
  sourceId: string;

  @Column("simple-json") conditions: RuleConditionNode;
}

@Entity()
export class ShopwareRulePrice extends VendureEntity {
  constructor(input?: DeepPartial<ShopwareRulePrice>) {
    super(input);
  }

  @Index()
  @ManyToOne((type) => ProductVariant, { onDelete: "CASCADE" })
  variant: ProductVariant;

  @Column() variantId: ID;

  @ManyToOne((type) => ShopwareRule, { onDelete: "CASCADE" })
  rule: ShopwareRule;

  @Column() ruleId: ID;

  @Column() currencyCode: string;

  @Column() quantityStart: number;

  /** null means open-ended, as in Shopware. */
  @Column({ type: "int", nullable: true }) quantityEnd: number | null;

  /** Minor units. Shopware stores both, the channel's tax mode decides which one is used. */
  @Column() net: number;

  @Column() gross: number;
}

// ---------------------------------------------------------------------------
// Part 2: condition evaluators. One per Shopware condition type in use.
// An unknown type must stop the import (see Part 8), never evaluate to true.
// ---------------------------------------------------------------------------

export interface RuleFacts {
  customerGroupNames: string[]; // TODO(build): map Shopware group ids to Vendure groups at import instead of names
  billingCountryCode: string | undefined;
  shopLocalWeekday: number; // ISO 1-7, in the shop timezone
  cartAmountGross: number; // minor units; 0 when there is no order (listing context)
  cartHasDigitalProducts: boolean;
}

type Evaluator = (node: RuleConditionNode, facts: RuleFacts) => boolean;

export const conditionEvaluators: Record<string, Evaluator> = {
  alwaysValid: () => true,

  andContainer: (node, facts) =>
    node.children.every((child) => evaluate(child, facts)),

  orContainer: (node, facts) =>
    node.children.some((child) => evaluate(child, facts)),

  customerCustomerGroup: (node, facts) => {
    // TODO(build): Shopware stores customerGroupIds plus an operator ('=' or '!=').
    throw new Error("customerCustomerGroup: not implemented in sketch");
  },

  customerBillingCountry: (node, facts) => {
    // TODO(build): countryIds + operator; map Shopware country ids to ISO codes at import.
    throw new Error("customerBillingCountry: not implemented in sketch");
  },

  dayOfWeek: (node, facts) => {
    // TODO(build): value.dayOfWeek + operator, evaluated in the shop timezone.
    throw new Error("dayOfWeek: not implemented in sketch");
  },

  cartCartAmount: (node, facts) => {
    // TODO(build): value.amount + operator ('>=', '<', ...). Shopware compares against the
    // cart total; confirm gross vs net for the sales channel's tax display before shipping.
    throw new Error("cartCartAmount: not implemented in sketch");
  },

  cartLineItemProductStates: (node, facts) => {
    // TODO(build): 'is-download' / 'is-physical' states against the order lines.
    throw new Error("cartLineItemProductStates: not implemented in sketch");
  },
};

export function evaluate(node: RuleConditionNode, facts: RuleFacts): boolean {
  const evaluator = conditionEvaluators[node.type];
  if (!evaluator) {
    // Guard only. The import rejects rules with unknown types, so this should never fire.
    throw new Error(`Unsupported Shopware rule condition type: ${node.type}`);
  }
  return evaluator(node, facts);
}

// ---------------------------------------------------------------------------
// Part 3: facts. Everything a condition may ask about, collected once per request.
// ---------------------------------------------------------------------------

export class RuleFactsProvider {
  constructor(
    private connection: TransactionalConnection,
    private cache: RequestContextCacheService,
  ) {}

  async getFacts(ctx: RequestContext, order?: Order): Promise<RuleFacts> {
    const customer = await this.getCustomer(ctx);
    return {
      customerGroupNames: customer?.groups?.map((g) => g.name) ?? [],
      // Prefer the order's billing address; fall back to the customer's default.
      billingCountryCode:
        order?.billingAddress?.countryCode ??
        customer?.addresses?.find((a) => a.defaultBillingAddress)?.country
          ?.code,
      shopLocalWeekday: isoWeekdayIn("Europe/Berlin"), // TODO(build): from config, not hardcoded
      cartAmountGross: order?.subTotalWithTax ?? 0,
      cartHasDigitalProducts: false, // TODO(build): derive from order lines
    };
  }

  private async getCustomer(
    ctx: RequestContext,
  ): Promise<Customer | undefined> {
    const userId = ctx.activeUserId;
    if (!userId) return undefined;
    const key = `shopware-rule-prices:customer:${userId}`;
    const cached = this.cache.get<Customer | null>(ctx, key);
    if (cached !== undefined) return cached ?? undefined;
    const customer = await this.connection
      .getRepository(ctx, Customer)
      .findOne({
        where: { user: { id: userId } },
        relations: ["groups", "addresses", "addresses.country"],
      });
    this.cache.set(ctx, key, customer ?? null);
    return customer ?? undefined;
  }
}

function isoWeekdayIn(timeZone: string): number {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone,
  }).format(new Date());
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(day) + 1;
}

// ---------------------------------------------------------------------------
// Part 4: the resolver. Reproduces ProductPriceCalculator::filterRulePrices.
// ---------------------------------------------------------------------------

export class RulePriceResolver {
  constructor(
    private connection: TransactionalConnection,
    private cache: RequestContextCacheService,
  ) {}

  /** Returns the rule price in minor units, or undefined to fall back to the base price. */
  async resolve(
    ctx: RequestContext,
    variantId: ID,
    quantity: number,
    facts: RuleFacts,
  ): Promise<number | undefined> {
    const rules = await this.getRulesInShopwareOrder(ctx);
    const matching = rules.filter((rule) => evaluate(rule.conditions, facts));
    if (matching.length === 0) return undefined;

    const prices = await this.getPricesForVariant(ctx, variantId);

    // First matching rule that HAS prices for this variant wins. Not the cheapest.
    for (const rule of matching) {
      const tiers = prices
        .filter((p) => p.ruleId === rule.id)
        .sort((a, b) => a.quantityStart - b.quantityStart);
      if (tiers.length === 0) continue;
      const tier = tiers.find(
        (t) =>
          t.quantityStart <= quantity &&
          (t.quantityEnd === null || quantity <= t.quantityEnd),
      );
      // TODO(build): confirm Shopware's behaviour when the quantity is outside every tier
      // of the winning rule; the sketch falls back to the highest tier.
      const chosen = tier ?? tiers[tiers.length - 1];
      return ctx.channel.pricesIncludeTax ? chosen.gross : chosen.net;
    }
    return undefined;
  }

  /** priority DESC, then source id ASC: the exact order RuleLoader uses. */
  private async getRulesInShopwareOrder(
    ctx: RequestContext,
  ): Promise<ShopwareRule[]> {
    const key = "shopware-rule-prices:rules";
    const cached = this.cache.get<ShopwareRule[]>(ctx, key);
    if (cached) return cached;
    const rules = await this.connection.getRepository(ctx, ShopwareRule).find({
      order: { priority: "DESC", sourceId: "ASC" },
    });
    // TODO(build): cache across requests and invalidate on rule change; rules change rarely.
    this.cache.set(ctx, key, rules);
    return rules;
  }

  private async getPricesForVariant(
    ctx: RequestContext,
    variantId: ID,
  ): Promise<ShopwareRulePrice[]> {
    // TODO(build): listings call this once per variant. Batch: load prices for every
    // variant on the page in one query and keep them in the request cache.
    return this.connection.getRepository(ctx, ShopwareRulePrice).find({
      where: { variantId, currencyCode: ctx.currencyCode },
    });
  }
}

// ---------------------------------------------------------------------------
// Part 5: catalogue price. Listing and detail pages, quantity 1, no order.
// Wraps whatever strategy was configured before (the default, or another plugin's),
// so Vendure's own tax handling stays in charge. The default strategy is not part of
// @vendure/core's public exports, which is one more reason to wrap instead of extend.
// ---------------------------------------------------------------------------

export class ShopwareRuleCatalogPriceStrategy implements ProductVariantPriceCalculationStrategy {
  private facts: RuleFactsProvider;
  private resolver: RulePriceResolver;

  constructor(private inner: ProductVariantPriceCalculationStrategy) {}

  async init(injector: Injector) {
    // The wrapped strategy is no longer in the config, so Vendure will not init it for us.
    await this.inner.init?.(injector);
    const connection = injector.get(TransactionalConnection);
    const cache = injector.get(RequestContextCacheService);
    this.facts = new RuleFactsProvider(connection, cache);
    this.resolver = new RulePriceResolver(connection, cache);
  }

  async destroy() {
    await this.inner.destroy?.();
  }

  async calculate(
    args: ProductVariantPriceCalculationArgs,
  ): Promise<PriceCalculationResult> {
    const facts = await this.facts.getFacts(args.ctx); // empty cart, like a Shopware listing
    const rulePrice = await this.resolver.resolve(
      args.ctx,
      args.productVariant.id,
      1,
      facts,
    );
    return this.inner.calculate(
      rulePrice === undefined ? args : { ...args, inputPrice: rulePrice },
    );
  }
}

// ---------------------------------------------------------------------------
// Part 6: cart price. Called per order line with the line quantity.
// Same wrapping: no rule price means the previously configured strategy decides.
// ---------------------------------------------------------------------------

export class ShopwareRuleOrderItemPriceStrategy implements OrderItemPriceCalculationStrategy {
  private facts: RuleFactsProvider;
  private resolver: RulePriceResolver;

  constructor(private inner: OrderItemPriceCalculationStrategy) {}

  async init(injector: Injector) {
    await this.inner.init?.(injector);
    const connection = injector.get(TransactionalConnection);
    const cache = injector.get(RequestContextCacheService);
    this.facts = new RuleFactsProvider(connection, cache);
    this.resolver = new RulePriceResolver(connection, cache);
  }

  async destroy() {
    await this.inner.destroy?.();
  }

  async calculateUnitPrice(
    ctx: RequestContext,
    productVariant: ProductVariant,
    orderLineCustomFields: { [key: string]: any },
    order: Order,
    quantity: number,
  ): Promise<PriceCalculationResult> {
    // Cart-amount conditions read the order totals from BEFORE this recalculation.
    // Shopware instead loops until the matched rule set is stable. See README, deviations.
    // TODO(build): decide between accepting that or a second recalculation pass.
    const facts = await this.facts.getFacts(ctx, order);
    const rulePrice = await this.resolver.resolve(
      ctx,
      productVariant.id,
      quantity,
      facts,
    );
    if (rulePrice !== undefined) {
      return {
        price: rulePrice,
        priceIncludesTax: ctx.channel.pricesIncludeTax,
      };
    }
    return this.inner.calculateUnitPrice(
      ctx,
      productVariant,
      orderLineCustomFields,
      order,
      quantity,
    );
  }
}

// ---------------------------------------------------------------------------
// Part 7: wiring. Registering this plugin is the switch; the sketch is not registered.
// ---------------------------------------------------------------------------

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [ShopwareRule, ShopwareRulePrice],
  configuration: (config) => {
    // Capture the strategies configured so far and wrap them.
    config.catalogOptions.productVariantPriceCalculationStrategy =
      new ShopwareRuleCatalogPriceStrategy(
        config.catalogOptions.productVariantPriceCalculationStrategy,
      );
    config.orderOptions.orderItemPriceCalculationStrategy =
      new ShopwareRuleOrderItemPriceStrategy(
        config.orderOptions.orderItemPriceCalculationStrategy,
      );
    return config;
  },
  compatibility: "^3.0.0",
})
export class ShopwareRulePricesPlugin {}

// ---------------------------------------------------------------------------
// Part 8: import step (belongs to the migrator, shown here to keep the parts together).
// ---------------------------------------------------------------------------

/**
 * Source queries, all filtered on LIVE_VERSION 0fa91ce3e96a4bc2be4bd9ce752c3425:
 *   rule:            id, name, priority
 *   rule_condition:  id, rule_id, parent_id, type, value, position  -> rebuild into RuleConditionNode trees
 *   product_price:   product_id, rule_id, quantity_start, quantity_end, price (JSON per currency)
 *
 * Steps:
 *   1. Inventory condition types across all rules. Any type without an evaluator in Part 2
 *      aborts the import with the list of rules using it. Never import a rule you cannot evaluate.
 *   2. Resolve inheritance: `prices` is an inheritable product field. A variant without its own
 *      product_price rows uses the parent's. (Demo shop: 0 variants rely on this, but the path must exist.)
 *   3. Map Shopware product ids to Vendure variant ids through the migrator's binding table.
 *   4. Expand the price JSON per currency. Convert net and gross to minor units with decimal
 *      arithmetic. A currency without an explicit price falls back to the default currency times
 *      the currency factor in Shopware; decide whether to materialise that or leave it out.
 *   5. Write ShopwareRule and ShopwareRulePrice rows. Idempotent on (rule sourceId) and
 *      (variant, rule, currency, quantityStart).
 */
export async function importRulePrices(): Promise<never> {
  throw new Error("TODO(build): import step not implemented in sketch");
}

// ---------------------------------------------------------------------------
// Part 9: parity proof. The only acceptable definition of done.
// ---------------------------------------------------------------------------

/**
 * For each fixture, record the price Shopware returns through the Store API with a matching
 * sales-channel context, then assert the resolver returns the same minor-unit amount.
 * Expected values come from Shopware, never from hand calculation.
 */
export const parityFixtures = [
  {
    case: "tie at priority 100 decided by rule id order",
    quantity: 1,
    customer: "guest",
    country: "DE",
    weekday: "Mon",
  },
  {
    case: "quantity just below, at and above a tier boundary",
    quantity: [9, 10, 11],
    customer: "guest",
    country: "DE",
    weekday: "Mon",
  },
  {
    case: "US billing country",
    quantity: 1,
    customer: "registered",
    country: "US",
    weekday: "Mon",
  },
  {
    case: "Sunday rule at priority 2 loses to any matching priority-100 rule",
    quantity: 1,
    customer: "guest",
    country: "DE",
    weekday: "Sun",
  },
  {
    case: "product without any rule price falls back to base price",
    quantity: 1,
    customer: "guest",
    country: "DE",
    weekday: "Mon",
  },
  {
    case: "cart crossing a cart-amount threshold (known deviation)",
    quantity: 1,
    customer: "guest",
    country: "DE",
    weekday: "Mon",
  },
] as const;
