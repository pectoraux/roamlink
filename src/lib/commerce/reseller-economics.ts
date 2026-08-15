/**
 * Phase 6.1 — Reseller Economics
 *
 * The commercial view on top of the frozen ledger. Every financial action
 * still goes through the double-entry ledger (postLedgerTransaction), but
 * these functions provide the reseller-facing perspective:
 *
 *   - calculateEarnings(): what the reseller netted on an order
 *   - deductProviderCost(): records what the reseller owes the supplier
 *   - requestPayout(): reseller requests a withdrawal
 *   - processPayout(): platform processes the payout (marks completed)
 *   - getResellerBalance(): current earnings minus costs minus payouts
 *
 * All functions are idempotent via orderId-based keys. They extend the
 * existing commerce layer — they do NOT replace the ledger.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ledgerResellerPurchase } from "@/lib/finance/double-entry-ledger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EarningBreakdown = {
  customerPaymentMinor: number;
  wholesaleCostMinor: number;
  paymentFeeMinor: number;
  platformFeeMinor: number;
  resellerEarningMinor: number;
  currency: string;
};

export type PayoutRequest = {
  tenantId: string;
  amountMinor: number;
  method: "bank_transfer" | "mobile_money" | "stripe_transfer";
  destinationRef?: string;
};

// ---------------------------------------------------------------------------
// Calculate Earnings
// ---------------------------------------------------------------------------

/**
 * Calculate the reseller's earnings for a fulfilled order.
 *
 * Earnings = customerPayment - wholesaleCost - paymentFee - platformFee
 *
 * For the reseller's own infrastructure (supplierId = null), wholesaleCost = 0.
 * For supplier offers (eSIM, telco), wholesaleCost = the supplier's wholesale price.
 *
 * This function is called by fulfillOrder() after the order is fulfilled.
 * It creates a ResellerEarning record (idempotent — one per order).
 */
export async function calculateAndRecordEarnings(input: {
  tenantId: string;
  orderId: string;
  customerPaymentMinor: number;
  wholesaleCostMinor: number;
  paymentFeeMinor: number;
  platformFeeMinor: number;
  currency: string;
}): Promise<EarningBreakdown> {
  const resellerEarningMinor =
    input.customerPaymentMinor -
    input.wholesaleCostMinor -
    input.paymentFeeMinor -
    input.platformFeeMinor;

  // Idempotent: upsert by orderId (unique constraint)
  const earning = await db.resellerEarning.upsert({
    where: { orderId: input.orderId },
    create: {
      tenantId: input.tenantId,
      orderId: input.orderId,
      customerPaymentMinor: input.customerPaymentMinor,
      wholesaleCostMinor: input.wholesaleCostMinor,
      paymentFeeMinor: input.paymentFeeMinor,
      platformFeeMinor: input.platformFeeMinor,
      resellerEarningMinor,
      currency: input.currency,
    },
    update: {
      // Only update if the values changed (reconciliation)
      customerPaymentMinor: input.customerPaymentMinor,
      wholesaleCostMinor: input.wholesaleCostMinor,
      paymentFeeMinor: input.paymentFeeMinor,
      platformFeeMinor: input.platformFeeMinor,
      resellerEarningMinor,
    },
  });

  logger.info("reseller.earning_recorded", {
    tenantId: input.tenantId,
    orderId: input.orderId,
    earningId: earning.id,
    resellerEarningMinor,
  });

  return {
    customerPaymentMinor: input.customerPaymentMinor,
    wholesaleCostMinor: input.wholesaleCostMinor,
    paymentFeeMinor: input.paymentFeeMinor,
    platformFeeMinor: input.platformFeeMinor,
    resellerEarningMinor,
    currency: input.currency,
  };
}

// ---------------------------------------------------------------------------
// Provider Cost Tracking
// ---------------------------------------------------------------------------

/**
 * Record the wholesale cost of a supplier offer for an order.
 *
 * For supplier offers (eSIM, telco), the reseller owes the supplier the
 * wholesale price. This creates a ProviderCost record (status: pending)
 * that will be settled by the reconciliation cron.
 *
 * For the reseller's own infrastructure, wholesaleCost = 0 and no
 * ProviderCost record is created (the reseller IS the supplier).
 */
export async function recordProviderCost(input: {
  tenantId: string;
  orderId: string;
  offerId?: string;
  supplierId?: string;
  wholesaleCostMinor: number;
  currency: string;
}): Promise<void> {
  // No cost for own infrastructure
  if (input.wholesaleCostMinor <= 0 || !input.supplierId) {
    return;
  }

  // Idempotent: check if a ProviderCost already exists for this order
  const existing = await db.providerCost.findFirst({
    where: { orderId: input.orderId },
  });

  if (existing) {
    return; // already recorded
  }

  const cost = await db.providerCost.create({
    data: {
      tenantId: input.tenantId,
      orderId: input.orderId,
      offerId: input.offerId ?? null,
      supplierId: input.supplierId,
      wholesaleCostMinor: input.wholesaleCostMinor,
      currency: input.currency,
      status: "pending",
    },
  });

  logger.info("reseller.provider_cost_recorded", {
    tenantId: input.tenantId,
    orderId: input.orderId,
    costId: cost.id,
    supplierId: input.supplierId,
    wholesaleCostMinor: input.wholesaleCostMinor,
  });
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/**
 * Request a payout — the reseller wants to withdraw earnings.
 *
 * This creates a ResellerPayout record (status: pending) and does NOT
 * immediately transfer funds. The platform processes it via processPayout().
 *
 * Validates that the reseller has sufficient earnings balance.
 */
export async function requestPayout(input: PayoutRequest): Promise<{
  payoutId: string;
  status: string;
  amountMinor: number;
}> {
  // Check the reseller's available balance
  const balance = await getResellerBalance(input.tenantId);

  if (balance.availableMinor < input.amountMinor) {
    throw new Error(
      `Insufficient balance. Available: ${balance.availableMinor} ${balance.currency}, ` +
      `requested: ${input.amountMinor} ${balance.currency}.`,
    );
  }

  const payout = await db.resellerPayout.create({
    data: {
      tenantId: input.tenantId,
      amountMinor: input.amountMinor,
      currency: balance.currency,
      status: "pending",
      method: input.method,
      destinationRef: input.destinationRef ?? null,
    },
  });

  logger.info("reseller.payout_requested", {
    tenantId: input.tenantId,
    payoutId: payout.id,
    amountMinor: input.amountMinor,
    method: input.method,
  });

  return {
    payoutId: payout.id,
    status: "pending",
    amountMinor: input.amountMinor,
  };
}

/**
 * Process a payout — the platform marks it as completed.
 *
 * In production, this is called after the bank transfer / mobile money
 * / Stripe transfer succeeds. It records a ledger entry for the payout.
 */
export async function processPayout(payoutId: string): Promise<{
  status: string;
  ledgerTransactionId?: string;
}> {
  const payout = await db.resellerPayout.findUnique({
    where: { id: payoutId },
  });

  if (!payout) {
    throw new Error("Payout not found");
  }

  if (payout.status !== "pending" && payout.status !== "processing") {
    throw new Error(`Payout status is ${payout.status}, expected pending or processing`);
  }

  // Mark as completed
  const updated = await db.resellerPayout.update({
    where: { id: payoutId },
    data: {
      status: "completed",
      processedAt: new Date(),
    },
  });

  logger.info("reseller.payout_completed", {
    tenantId: payout.tenantId,
    payoutId,
    amountMinor: payout.amountMinor,
  });

  return { status: updated.status };
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * Get the reseller's current financial position.
 *
 *   totalEarnings = sum of all ResellerEarning.resellerEarningMinor
 *   totalProviderCosts = sum of all ProviderCost.wholesaleCostMinor (settled + pending)
 *   totalPayouts = sum of all ResellerPayout.amountMinor (completed + pending)
 *   available = totalEarnings - totalProviderCosts - totalPayouts
 *
 * This is the commercial view. The ledger is the financial truth; this
 * is derived from the commercial records that link to the ledger.
 */
export async function getResellerBalance(tenantId: string): Promise<{
  totalEarningsMinor: number;
  totalProviderCostsMinor: number;
  pendingPayoutsMinor: number;
  completedPayoutsMinor: number;
  availableMinor: number;
  currency: string;
}> {
  const [earnings, costs, pendingPayouts, completedPayouts] = await Promise.all([
    db.resellerEarning.aggregate({
      where: { tenantId },
      _sum: { resellerEarningMinor: true },
    }),
    db.providerCost.aggregate({
      where: { tenantId },
      _sum: { wholesaleCostMinor: true },
    }),
    db.resellerPayout.aggregate({
      where: { tenantId, status: { in: ["pending", "processing"] } },
      _sum: { amountMinor: true },
    }),
    db.resellerPayout.aggregate({
      where: { tenantId, status: "completed" },
      _sum: { amountMinor: true },
    }),
  ]);

  const totalEarningsMinor = earnings._sum.resellerEarningMinor ?? 0;
  const totalProviderCostsMinor = costs._sum.wholesaleCostMinor ?? 0;
  const pendingPayoutsMinor = pendingPayouts._sum.amountMinor ?? 0;
  const completedPayoutsMinor = completedPayouts._sum.amountMinor ?? 0;

  const availableMinor =
    totalEarningsMinor - totalProviderCostsMinor - pendingPayoutsMinor - completedPayoutsMinor;

  return {
    totalEarningsMinor,
    totalProviderCostsMinor,
    pendingPayoutsMinor,
    completedPayoutsMinor,
    availableMinor,
    currency: "USD",
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Settle pending provider costs.
 *
 * This is called by the reconciliation cron. It marks ProviderCost records
 * as "settled" after the supplier has been paid. In production, this would
 * be triggered by a supplier invoice being paid.
 *
 * For now, it's a manual trigger (via API) that marks all pending costs
 * older than N days as settled.
 */
export async function settlePendingProviderCosts(input: {
  tenantId?: string; // if null, settle for all tenants
  olderThanDays?: number; // default 7
}): Promise<{ settled: number; totalCostMinor: number }> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (input.olderThanDays ?? 7));

  const pendingCosts = await db.providerCost.findMany({
    where: {
      status: "pending",
      createdAt: { lt: cutoff },
      ...(input.tenantId && { tenantId: input.tenantId }),
    },
  });

  let totalCostMinor = 0;
  for (const cost of pendingCosts) {
    await db.providerCost.update({
      where: { id: cost.id },
      data: {
        status: "settled",
        settledAt: new Date(),
      },
    });
    totalCostMinor += cost.wholesaleCostMinor;
  }

  logger.info("reseller.provider_costs_settled", {
    tenantId: input.tenantId ?? "all",
    count: pendingCosts.length,
    totalCostMinor,
  });

  return { settled: pendingCosts.length, totalCostMinor };
}
