/**
 * Tenant entitlements — server-side enforcement of SaaS plan limits.
 *
 * Phase 2B: Entitlements are checked server-side on every relevant operation.
 * The UI may show/hide features, but the server is the authority.
 *
 * Entitlement dimensions:
 *   - includedStaff (max TenantUser count)
 *   - includedCustomers (max TenantCustomer count)
 *   - includedOrdersPerMonth (max orders per calendar month)
 *   - platformFeePercent (percentage taken as platform fee)
 *   - perOrderFeeMinor (flat fee per order)
 *   - features (feature flags from the SaaS plan)
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export type Entitlements = {
  saaasPlanName: string;
  monthlyPriceMinor: number;
  includedStaff: number;
  includedCustomers: number;
  includedOrdersPerMonth: number;
  platformFeePercent: number;
  perOrderFeeMinor: number;
  features: string[];
  subscriptionStatus: string;
  currentPeriodEnd: Date;
};

/**
 * Get the entitlements for a tenant. If no active subscription, return
 * the "free" plan defaults (or throw if the tenant must have a subscription).
 */
export async function getTenantEntitlements(tenantId: string): Promise<Entitlements> {
  const subscription = await db.tenantSubscription.findUnique({
    where: { tenantId },
    include: { saaasPlan: true },
  });

  if (!subscription) {
    // No subscription — return free-tier defaults
    return {
      saaasPlanName: "free",
      monthlyPriceMinor: 0,
      includedStaff: 1,
      includedCustomers: 10,
      includedOrdersPerMonth: 50,
      platformFeePercent: 5, // 5% platform fee on free tier
      perOrderFeeMinor: 0,
      features: ["basic_dashboard"],
      subscriptionStatus: "none",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  const plan = subscription.saaasPlan;
  let features: string[] = [];
  try {
    features = plan.features ? JSON.parse(plan.features) : [];
  } catch {
    features = [];
  }

  return {
    saaasPlanName: plan.name,
    monthlyPriceMinor: plan.monthlyPriceMinor,
    includedStaff: plan.includedStaff,
    includedCustomers: plan.includedCustomers,
    includedOrdersPerMonth: plan.includedOrdersPerMonth,
    platformFeePercent: plan.platformFeePercent,
    perOrderFeeMinor: plan.perOrderFeeMinor,
    features,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

/**
 * Check if the tenant can add a new staff member.
 * Throws AppError(usage_limit) if the limit is reached.
 */
export async function assertCanAddStaff(tenantId: string): Promise<void> {
  const ent = await getTenantEntitlements(tenantId);
  const count = await db.tenantUser.count({ where: { tenantId } });
  if (count >= ent.includedStaff) {
    throw new AppError(
      "usage_limit",
      `Staff limit reached (${count}/${ent.includedStaff})`,
      402,
      `Your ${ent.saaasPlanName} plan allows ${ent.includedStaff} staff members. Upgrade to add more.`,
    );
  }
}

/**
 * Check if the tenant can add a new customer.
 * Throws AppError(usage_limit) if the limit is reached.
 */
export async function assertCanAddCustomer(tenantId: string): Promise<void> {
  const ent = await getTenantEntitlements(tenantId);
  const count = await db.tenantCustomer.count({ where: { tenantId } });
  if (count >= ent.includedCustomers) {
    throw new AppError(
      "usage_limit",
      `Customer limit reached (${count}/${ent.includedCustomers})`,
      402,
      `Your ${ent.saaasPlanName} plan allows ${ent.includedCustomers} customers. Upgrade to add more.`,
    );
  }
}

/**
 * Check if the tenant can create a new order this month.
 * Throws AppError(usage_limit) if the monthly limit is reached.
 */
export async function assertCanCreateOrder(tenantId: string): Promise<void> {
  const ent = await getTenantEntitlements(tenantId);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const count = await db.order.count({
    where: { tenantId, createdAt: { gte: monthStart } },
  });
  if (count >= ent.includedOrdersPerMonth) {
    throw new AppError(
      "usage_limit",
      `Monthly order limit reached (${count}/${ent.includedOrdersPerMonth})`,
      402,
      `Your ${ent.saaasPlanName} plan allows ${ent.includedOrdersPerMonth} orders per month. Upgrade for more.`,
    );
  }
}

/**
 * Calculate the platform fee for an order.
 * Returns { platformFeeMinor, perOrderFeeMinor, totalFeeMinor }.
 */
export async function calculatePlatformFee(
  tenantId: string,
  orderAmountMinor: number,
): Promise<{ platformFeeMinor: number; perOrderFeeMinor: number; totalFeeMinor: number }> {
  const ent = await getTenantEntitlements(tenantId);
  const platformFeeMinor = Math.round(orderAmountMinor * (ent.platformFeePercent / 100));
  const perOrderFeeMinor = ent.perOrderFeeMinor;
  return {
    platformFeeMinor,
    perOrderFeeMinor,
    totalFeeMinor: platformFeeMinor + perOrderFeeMinor,
  };
}

/**
 * Seed the default SaaS plans if they don't exist.
 * Called during setup/migration.
 */
export async function seedSaaasPlans(): Promise<void> {
  const plans = [
    {
      name: "free",
      displayName: "Free",
      monthlyPriceMinor: 0,
      includedStaff: 1,
      includedCustomers: 10,
      includedOrdersPerMonth: 50,
      platformFeePercent: 5,
      perOrderFeeMinor: 0,
      features: JSON.stringify(["basic_dashboard"]),
    },
    {
      name: "starter",
      displayName: "Starter",
      monthlyPriceMinor: 2900, // $29/mo
      includedStaff: 3,
      includedCustomers: 100,
      includedOrdersPerMonth: 500,
      platformFeePercent: 3,
      perOrderFeeMinor: 0,
      features: JSON.stringify(["basic_dashboard", "api_access", "custom_pricing"]),
    },
    {
      name: "business",
      displayName: "Business",
      monthlyPriceMinor: 9900, // $99/mo
      includedStaff: 20,
      includedCustomers: 2000,
      includedOrdersPerMonth: 5000,
      platformFeePercent: 2,
      perOrderFeeMinor: 0,
      features: JSON.stringify(["basic_dashboard", "api_access", "custom_pricing", "advanced_analytics", "team_roles"]),
    },
    {
      name: "enterprise",
      displayName: "Enterprise",
      monthlyPriceMinor: 0, // negotiated
      includedStaff: 999999,
      includedCustomers: 999999,
      includedOrdersPerMonth: 999999,
      platformFeePercent: 0, // negotiated
      perOrderFeeMinor: 0,
      features: JSON.stringify(["basic_dashboard", "api_access", "custom_pricing", "advanced_analytics", "team_roles", "sso", "white_label", "priority_support"]),
    },
  ];

  for (const plan of plans) {
    const existing = await db.saaasPlan.findUnique({ where: { name: plan.name } });
    if (!existing) {
      await db.saaasPlan.create({ data: plan });
    }
  }
}
