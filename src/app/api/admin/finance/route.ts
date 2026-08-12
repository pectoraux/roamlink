import { requireAdmin } from "@/lib/auth";
import { getFinancialSummary, getOrderFinancials } from "@/lib/finance/ledger";
import { getAllProviderAccounts } from "@/lib/finance/provider-credit";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";

/** GET /api/admin/finance — business intelligence dashboard data. */
export async function GET() {
  try {
    await requireAdmin();

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [today, thisMonth, lastMonth, providerAccounts, activeESIMs, activeNumbers, totalUsers, successfulOrders, failedOrders] = await Promise.all([
      getFinancialSummary(todayStart, now),
      getFinancialSummary(monthStart, now),
      getFinancialSummary(lastMonthStart, monthStart),
      getAllProviderAccounts(),
      db.esim.count({ where: { status: "active" } }),
      db.virtualNumber.count({ where: { status: "active" } }),
      db.user.count({ where: { role: "customer" } }),
      db.order.count({ where: { status: "COMPLETED" } }),
      db.order.count({ where: { status: { in: ["PAYMENT_FAILED", "PROVISIONING_FAILED", "CANCELLED"] } } }),
    ]);

    // Calculate second purchase rate
    const usersWithMultipleOrders = await db.order.groupBy({
      by: ["userId"],
      where: { status: "COMPLETED" },
      _count: { _all: true },
      having: { userId: { _count: { gt: 1 } } },
    });
    const secondPurchaseRate = totalUsers > 0 ? (usersWithMultipleOrders.length / totalUsers) * 100 : 0;

    // MRR estimate: active numbers * their monthly price
    const activeVNPrices = await db.virtualNumber.findMany({ where: { status: "active" }, select: { sellingPrice: true } });
    const mrr = activeVNPrices.reduce((sum, vn) => sum + vn.sellingPrice, 0);

    return json({
      today: {
        ...today,
        activeESIMs,
        activeNumbers,
        successfulOrders,
        failedOrders,
      },
      thisMonth: {
        ...thisMonth,
        mrr,
        newUsers: await db.user.count({ where: { role: "customer", createdAt: { gte: monthStart } } }),
        secondPurchaseRate: Math.round(secondPurchaseRate * 100) / 100,
      },
      lastMonth,
      providers: providerAccounts.map((p) => ({
        provider: p.provider,
        creditLimit: p.creditLimit,
        outstandingLiability: p.outstandingLiability,
        pendingCommitments: p.pendingCommitments,
        availableCredit: p.availableCredit,
        utilization: p.utilization,
        invoicedAmount: p.invoicedAmount,
        paidAmount: p.paidAmount,
        alertLevel: p.alertLevel,
        canCommit: p.canCommit,
        invoices: p.invoices,
      })),
      metrics: {
        totalUsers,
        activeESIMs,
        activeNumbers,
        successfulOrders,
        failedOrders,
        mrr,
        secondPurchaseRate: Math.round(secondPurchaseRate * 100) / 100,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
