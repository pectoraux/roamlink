/**
 * Phase 7.2 — Settlement Service
 *
 * Supplier settlement: aggregates ProviderCost records into settlement
 * periods, generates invoices, and tracks payment.
 *
 * Reseller settlement: payout processing + history. The existing
 * requestPayout/processPayout handle individual payouts; this adds
 * settlement-period aggregation and history views.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordProviderInvoice } from "@/lib/finance/provider-credit";

// ---------------------------------------------------------------------------
// Supplier Settlement
// ---------------------------------------------------------------------------

/**
 * Create a supplier settlement for a period.
 *
 * Aggregates all pending ProviderCost records for a specific supplier
 * into a single SupplierSettlement. This is the "invoice" the reseller
 * owes the supplier for that period.
 */
export async function createSupplierSettlement(input: {
  tenantId: string;
  supplierId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{
  settlementId: string;
  totalCostMinor: number;
  costCount: number;
  status: string;
}> {
  // Find all pending costs for this supplier in the period
  const costs = await db.providerCost.findMany({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      status: "pending",
      createdAt: {
        gte: input.periodStart,
        lte: input.periodEnd,
      },
    },
  });

  if (costs.length === 0) {
    return { settlementId: "", totalCostMinor: 0, costCount: 0, status: "empty" };
  }

  const totalCostMinor = costs.reduce((sum, c) => sum + c.wholesaleCostMinor, 0);

  // Create the settlement
  const settlement = await db.supplierSettlement.create({
    data: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalCostMinor,
      currency: costs[0].currency,
      status: "pending",
      costCount: costs.length,
    },
  });

  // Mark the costs as settled and link to the settlement
  await db.providerCost.updateMany({
    where: {
      id: { in: costs.map((c) => c.id) },
    },
    data: {
      status: "settled",
      settledAt: new Date(),
    },
  });

  logger.info("settlement.supplier_created", {
    tenantId: input.tenantId,
    supplierId: input.supplierId,
    settlementId: settlement.id,
    totalCostMinor,
    costCount: costs.length,
  });

  return {
    settlementId: settlement.id,
    totalCostMinor,
    costCount: costs.length,
    status: "pending",
  };
}

/**
 * Generate a provider invoice from a settlement.
 *
 * Links the settlement to a ProviderInvoice record (existing model from
 * the finance layer). This is the formal invoice the supplier sends to
 * the reseller.
 */
export async function generateSupplierInvoice(settlementId: string): Promise<{
  invoiceId: string;
  providerInvoiceId: string;
  amountMinor: number;
}> {
  const settlement = await db.supplierSettlement.findUnique({
    where: { id: settlementId },
  });

  if (!settlement) {
    throw new Error("Settlement not found");
  }

  if (settlement.status !== "pending") {
    throw new Error(`Settlement status is ${settlement.status}, expected pending`);
  }

  // Create a ProviderInvoice via the existing finance function
  await recordProviderInvoice({
    provider: settlement.supplierId,
    amountMinor: settlement.totalCostMinor,
    currency: settlement.currency,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
  });

  // Mark settlement as invoiced
  await db.supplierSettlement.update({
    where: { id: settlementId },
    data: { status: "invoiced" },
  });

  logger.info("settlement.invoice_generated", {
    settlementId,
    supplierId: settlement.supplierId,
    amountMinor: settlement.totalCostMinor,
  });

  return {
    invoiceId: settlementId,
    providerInvoiceId: settlement.supplierId,
    amountMinor: settlement.totalCostMinor,
  };
}

/**
 * Mark a supplier settlement as paid.
 */
export async function settleSupplierInvoice(settlementId: string): Promise<{
  status: string;
}> {
  const settlement = await db.supplierSettlement.findUnique({
    where: { id: settlementId },
  });

  if (!settlement) {
    throw new Error("Settlement not found");
  }

  if (settlement.status !== "invoiced") {
    throw new Error(`Settlement status is ${settlement.status}, expected invoiced`);
  }

  await db.supplierSettlement.update({
    where: { id: settlementId },
    data: {
      status: "paid",
      updatedAt: new Date(),
    },
  });

  logger.info("settlement.supplier_paid", {
    settlementId,
    supplierId: settlement.supplierId,
    amountMinor: settlement.totalCostMinor,
  });

  return { status: "paid" };
}

// ---------------------------------------------------------------------------
// Reseller Settlement (payout history + summary)
// ---------------------------------------------------------------------------

/**
 * Get the reseller's payout history + settlement summary.
 */
export async function getResellerSettlementSummary(tenantId: string): Promise<{
  totalEarnings: number;
  totalProviderCosts: number;
  totalPayouts: number;
  pendingPayouts: number;
  availableBalance: number;
  payoutHistory: Array<{
    id: string;
    amountMinor: number;
    status: string;
    method: string;
    createdAt: string;
    processedAt: string | null;
  }>;
  supplierSettlements: Array<{
    id: string;
    supplierId: string;
    totalCostMinor: number;
    status: string;
    periodStart: string;
    periodEnd: string;
  }>;
}> {
  const [earnings, costs, payouts, pendingPayouts, payoutHistory, supplierSettlements] = await Promise.all([
    db.resellerEarning.aggregate({
      where: { tenantId },
      _sum: { resellerEarningMinor: true },
    }),
    db.providerCost.aggregate({
      where: { tenantId },
      _sum: { wholesaleCostMinor: true },
    }),
    db.resellerPayout.aggregate({
      where: { tenantId, status: "completed" },
      _sum: { amountMinor: true },
    }),
    db.resellerPayout.aggregate({
      where: { tenantId, status: { in: ["pending", "processing"] } },
      _sum: { amountMinor: true },
    }),
    db.resellerPayout.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.supplierSettlement.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const totalEarnings = earnings._sum.resellerEarningMinor ?? 0;
  const totalProviderCosts = costs._sum.wholesaleCostMinor ?? 0;
  const totalPayouts = payouts._sum.amountMinor ?? 0;
  const pendingPayoutsAmount = pendingPayouts._sum.amountMinor ?? 0;
  const availableBalance = totalEarnings - totalProviderCosts - totalPayouts - pendingPayoutsAmount;

  return {
    totalEarnings,
    totalProviderCosts,
    totalPayouts,
    pendingPayouts: pendingPayoutsAmount,
    availableBalance,
    payoutHistory: payoutHistory.map((p) => ({
      id: p.id,
      amountMinor: p.amountMinor,
      status: p.status,
      method: p.method,
      createdAt: p.createdAt.toISOString(),
      processedAt: p.processedAt?.toISOString() ?? null,
    })),
    supplierSettlements: supplierSettlements.map((s) => ({
      id: s.id,
      supplierId: s.supplierId,
      totalCostMinor: s.totalCostMinor,
      status: s.status,
      periodStart: s.periodStart.toISOString(),
      periodEnd: s.periodEnd.toISOString(),
    })),
  };
}
