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

  const prevSince = new Date();
  prevSince.setDate(prevSince.getDate() - (days * 2));

  const [
    earnings,
    orders,
    activeEntitlements,
    totalCustomers,
    recentOrders,
    bestSellingProducts,
    churnedCustomers,
    activeUsersTrend,
    avgRating,
    uptimeStats,
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

    // Best-selling offers (top 5 by revenue)
    db.customerOrder.groupBy({
      by: ["productId"],
      where: { tenantId, createdAt: { gte: since }, status: "fulfilled" },
      _sum: { paidAmountMinor: true },
      _count: true,
      orderBy: { _sum: { paidAmountMinor: "desc" } },
      take: 5,
    }),

    // Churned customers: had an order in the previous period but not in the current
    db.customerOrder.findMany({
      where: { tenantId, createdAt: { gte: prevSince, lt: since } },
      select: { customerId: true },
      distinct: ["customerId"],
    }),

    // Active users trend: customers with orders per day
    db.customerOrder.findMany({
      where: { tenantId, createdAt: { gte: since } },
      select: { customerId: true, createdAt: true },
    }),

    // Average offer rating
    db.offerRating.aggregate({
      where: { tenantId },
      _avg: { rating: true },
      _count: true,
    }),

    // Uptime stats (last 24h)
    db.uptimeMeasurement.aggregate({
      where: { tenantId, measuredAt: { gte: new Date(Date.now() - 86400000) } },
      _avg: { responseTimeMs: true },
      _count: true,
    }),
  ]);

  // Get product names for best-selling
  const productIds = bestSellingProducts.map((p) => p.productId);
  const products = await db.resellerProduct.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p.name]));

  // Calculate churn rate
  const prevCustomers = new Set(churnedCustomers.map((c) => c.customerId));
  const currentCustomers = new Set(totalCustomers.map((c) => c.customerId));
  const churned = [...prevCustomers].filter((c) => !currentCustomers.has(c)).length;
  const churnRate = prevCustomers.size > 0 ? (churned / prevCustomers.size) * 100 : 0;

  // Calculate active users per day
  const usersByDay = new Map<string, Set<string>>();
  for (const order of activeUsersTrend) {
    const day = order.createdAt.toISOString().split("T")[0];
    if (!usersByDay.has(day)) usersByDay.set(day, new Set());
    usersByDay.get(day)!.add(order.customerId);
  }
  const activeUsersPerDay = Array.from(usersByDay.entries()).map(([day, users]) => ({
    day,
    activeUsers: users.size,
  })).sort((a, b) => a.day.localeCompare(b.day));

  // Uptime percentage
  const uptimeMeasurements = await db.uptimeMeasurement.findMany({
    where: { tenantId, measuredAt: { gte: new Date(Date.now() - 86400000) } },
    select: { isReachable: true },
  });
  const uptimePercent = uptimeMeasurements.length > 0
    ? (uptimeMeasurements.filter((m) => m.isReachable).length / uptimeMeasurements.length) * 100
    : 100; // default to 100% if no measurements

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
    churnRate: Math.round(churnRate * 10) / 10,
    avgRating: avgRating._avg.rating ? Math.round(avgRating._avg.rating * 10) / 10 : null,
    ratingCount: avgRating._count,
    uptimePercent: Math.round(uptimePercent * 10) / 10,
    avgResponseTimeMs: uptimeStats._avg.responseTimeMs ?? null,
    ordersByStatus: orders.reduce((acc, o) => {
      acc[o.status] = o._count;
      return acc;
    }, {} as Record<string, number>),
    recentOrders,
    bestSellingOffers: bestSellingProducts.map((p) => ({
      productId: p.productId,
      productName: productMap.get(p.productId) ?? "Unknown",
      revenue: p._sum.paidAmountMinor ?? 0,
      orderCount: p._count,
    })),
    activeUsersPerDay,
  };
}
