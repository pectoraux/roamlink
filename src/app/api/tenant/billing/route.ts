/**
 * Tenant Billing API.
 *   GET /api/tenant/billing — returns entitlements + subscription + usage
 */

import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getTenantEntitlements, calculatePlatformFee } from "@/lib/tenant/entitlements";
import { getOrCreateTenantBalance, listTenantTransactions } from "@/lib/tenant/balance";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);

    const entitlements = await getTenantEntitlements(ctx.tenantId);
    const subscription = await db.tenantSubscription.findUnique({
      where: { tenantId: ctx.tenantId },
      include: { saaasPlan: true },
    });

    // Calculate current month usage
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [ordersThisMonth, customers, staff] = await Promise.all([
      db.order.count({ where: { tenantId: ctx.tenantId, createdAt: { gte: monthStart } } }),
      db.tenantCustomer.count({ where: { tenantId: ctx.tenantId } }),
      db.tenantUser.count({ where: { tenantId: ctx.tenantId } }),
    ]);

    // Calculate total platform fees this month (sum of order amounts * fee%)
    const monthOrders = await db.order.findMany({
      where: { tenantId: ctx.tenantId, createdAt: { gte: monthStart } },
      select: { amount: true },
    });
    const totalOrderVolume = monthOrders.reduce((s, o) => s + o.amount, 0);
    const feeCalc = await calculatePlatformFee(ctx.tenantId, totalOrderVolume);

    // Phase 2B.1: reseller prepaid balance + recent transactions
    const [balance, transactions] = await Promise.all([
      getOrCreateTenantBalance(ctx.tenantId),
      listTenantTransactions(ctx.tenantId, 10),
    ]);

    return json({
      entitlements,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            plan: subscription.saaasPlan,
            currentPeriodEnd: subscription.currentPeriodEnd,
            billingCycle: subscription.billingCycle,
          }
        : null,
      usage: {
        ordersThisMonth,
        customers,
        staff,
        includedOrdersPerMonth: entitlements.includedOrdersPerMonth,
        includedCustomers: entitlements.includedCustomers,
        includedStaff: entitlements.includedStaff,
      },
      billing: {
        totalOrderVolumeMinor: totalOrderVolume,
        platformFeeMinor: feeCalc.totalFeeMinor,
        platformFeePercent: entitlements.platformFeePercent,
        perOrderFeeMinor: entitlements.perOrderFeeMinor,
        saasMonthlyPriceMinor: entitlements.monthlyPriceMinor,
        balanceMinor: balance.balanceMinor,
        totalDepositedMinor: balance.totalDepositedMinor,
        totalSpentMinor: balance.totalSpentMinor,
      },
      transactions,
    }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
