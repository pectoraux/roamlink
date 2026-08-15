/**
 * Phase 6.6 — Reseller Analytics
 *
 * Dashboard data for the reseller: revenue, profit, customers, usage.
 * All data is derived from the existing models (ResellerEarning,
 * CustomerOrder, ConnectivityEntitlement) — no new tracking needed.
 */

import { db } from "@/lib/db";

export async function getResellerAnalytics(tenantId: string, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [
    earnings,
    orders,
    activeEntitlements,
    totalCustomers,
    recentOrders,
  ] = await Promise.all([
    // Revenue + profit from earnings
    db.resellerEarning.aggregate({
      where: { tenantId, createdAt: { gte: since } },
      _sum: {
        customerPaymentMinor: true,
        wholesaleCostMinor: true,
        paymentFeeMinor: true,
        platformFeeMinor: true,
        resellerEarningMinor: true,
      },
      _count: true,
    }),

    // Order stats
    db.customerOrder.groupBy({
      by: ["status"],
      where: { tenantId, createdAt: { gte: since } },
      _count: true,
    }),

    // Active entitlements
    db.connectivityEntitlement.count({
      where: { tenantId, status: "ACTIVE" },
    }),

    // Total customers (unique users who have placed an order)
    db.customerOrder.findMany({
      where: { tenantId },
      select: { customerId: true },
      distinct: ["customerId"],
    }),

    // Recent orders
    db.customerOrder.findMany({
      where: { tenantId, createdAt: { gte: since } },
      include: {
        product: { select: { name: true } },
        customer: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const revenue = earnings._sum.customerPaymentMinor ?? 0;
  const profit = earnings._sum.resellerEarningMinor ?? 0;
  const costs = earnings._sum.wholesaleCostMinor ?? 0;
  const fees = earnings._sum.paymentFeeMinor ?? 0;
  const platformFees = earnings._sum.platformFeeMinor ?? 0;

  return {
    period: { days, since },
    revenue,
    profit,
    costs,
    fees,
    platformFees,
    orderCount: earnings._count,
    activeEntitlements,
    customerCount: totalCustomers.length,
    ordersByStatus: orders.reduce((acc, o) => {
      acc[o.status] = o._count;
      return acc;
    }, {} as Record<string, number>),
    recentOrders,
  };
}
