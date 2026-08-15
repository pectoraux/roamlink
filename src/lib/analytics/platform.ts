/**
 * Phase 6.6 — Platform Analytics (RoamLink admin)
 *
 * Dashboard data for the RoamLink platform operator: GMV, contribution
 * profit, provider exposure, active operators, retention.
 */

import { db } from "@/lib/db";

export async function getPlatformAnalytics(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [
    gmv,
    platformFees,
    activeTenants,
    totalOrders,
    providerExposure,
    topTenants,
  ] = await Promise.all([
    // GMV = total customer payments across all tenants
    db.resellerEarning.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { customerPaymentMinor: true },
    }),

    // Platform fees collected
    db.resellerEarning.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { platformFeeMinor: true },
    }),

    // Active tenants (with at least one order in the period)
    db.customerOrder.findMany({
      where: { createdAt: { gte: since } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),

    // Total orders
    db.customerOrder.count({
      where: { createdAt: { gte: since } },
    }),

    // Provider exposure = sum of pending provider costs
    db.providerCost.aggregate({
      where: { status: "pending" },
      _sum: { wholesaleCostMinor: true },
    }),

    // Top tenants by revenue
    db.resellerEarning.groupBy({
      by: ["tenantId"],
      where: { createdAt: { gte: since } },
      _sum: { customerPaymentMinor: true, resellerEarningMinor: true },
      orderBy: { _sum: { customerPaymentMinor: "desc" } },
      take: 10,
    }),
  ]);

  // Get tenant names for top tenants
  const tenantIds = topTenants.map((t) => t.tenantId);
  const tenants = await db.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true, slug: true },
  });
  const tenantMap = new Map(tenants.map((t) => [t.id, t]));

  return {
    period: { days, since },
    gmv: gmv._sum.customerPaymentMinor ?? 0,
    platformFees: platformFees._sum.platformFeeMinor ?? 0,
    activeTenants: activeTenants.length,
    totalOrders,
    providerExposure: providerExposure._sum.wholesaleCostMinor ?? 0,
    topTenants: topTenants.map((t) => ({
      tenantId: t.tenantId,
      tenantName: tenantMap.get(t.tenantId)?.name ?? "Unknown",
      revenue: t._sum.customerPaymentMinor ?? 0,
      profit: t._sum.resellerEarningMinor ?? 0,
    })),
  };
}
