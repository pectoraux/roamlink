/**
 * Pricing engine — computes retail price from wholesale cost + markup rules.
 *
 *   wholesale + markup (+ optional fees) = retail
 *
 * Rules live in the PricingRule table and are evaluated by priority (higher
 * wins). Supports fixed (minor units) and percentage (basis points) markups,
 * scoped globally, by country, or by region.
 *
 * Retail prices are NEVER hard-coded into provider integrations.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export type PricingDecision = {
  wholesaleMinor: number;
  retailMinor: number;
  ruleName: string;
  ruleType: "fixed" | "percentage";
  ruleValue: number;
};

/** Default fallback markup if no rules are configured: 30%. */
const DEFAULT_MARKUP_PERCENT = 30;

/**
 * Compute the retail price for a plan given its wholesale cost and country/region.
 * Falls back to a default percentage markup if no rules match.
 */
export async function computeRetailPrice(input: {
  wholesaleMinor: number;
  countryCode: string;
  region: string;
  currency: string;
}): Promise<PricingDecision> {
  const rules = await db.pricingRule.findMany({
    where: { active: true, OR: [{ scope: "global" }, { scope: "country", scopeValue: input.countryCode }, { scope: "region", scopeValue: input.region }] },
    orderBy: { priority: "desc" },
  });

  if (rules.length === 0) {
    const markup = Math.round((input.wholesaleMinor * DEFAULT_MARKUP_PERCENT) / 100);
    return {
      wholesaleMinor: input.wholesaleMinor,
      retailMinor: input.wholesaleMinor + markup,
      ruleName: "default-30-percent",
      ruleType: "percentage",
      ruleValue: DEFAULT_MARKUP_PERCENT,
    };
  }

  // Highest-priority rule wins.
  const rule = rules[0];
  let markup: number;
  if (rule.type === "fixed") {
    markup = rule.value;
  } else {
    // percentage stored as basis points? We store percent directly (30 = 30%).
    markup = Math.round((input.wholesaleMinor * rule.value) / 100);
  }
  return {
    wholesaleMinor: input.wholesaleMinor,
    retailMinor: input.wholesaleMinor + markup,
    ruleName: rule.name,
    ruleType: rule.type as "fixed" | "percentage",
    ruleValue: rule.value,
  };
}

/** Seed default pricing rules if none exist. */
export async function ensureDefaultPricingRules(): Promise<void> {
  const count = await db.pricingRule.count();
  if (count > 0) return;
  await db.pricingRule.createMany({
    data: [
      { name: "Africa 35%", type: "percentage", value: 35, scope: "region", scopeValue: "Africa", priority: 10 },
      { name: "Europe 25%", type: "percentage", value: 25, scope: "region", scopeValue: "Europe", priority: 10 },
      { name: "North America 25%", type: "percentage", value: 25, scope: "region", scopeValue: "North America", priority: 10 },
      { name: "Global 30%", type: "percentage", value: 30, scope: "global", priority: 1 },
    ],
  });
  logger.info("pricing.default_rules_seeded");
}
