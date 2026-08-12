/**
 * Financial Ledger — immutable record of all financial events.
 *
 * Financial truth must not depend exclusively on mutable order records.
 * Every financial event (payment, provider purchase, refund, fee) is recorded
 * as an immutable FinancialTransaction with full breakdown.
 *
 * All amounts are integer minor units. Never floating point.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export type FinancialEventType =
  | "CUSTOMER_PAYMENT"
  | "PAYMENT_FEE"
  | "PROVIDER_PURCHASE"
  | "PROVIDER_LIABILITY"
  | "PROVIDER_INVOICE"
  | "PROVIDER_PAYMENT"
  | "REFUND"
  | "CHARGEBACK"
  | "PROMOTIONAL_CREDIT"
  | "CUSTOMER_CREDIT"
  | "TRIAL_COST"
  | "COMMISSION"
  | "ADJUSTMENT";

export type LedgerEntry = {
  type: FinancialEventType;
  userId?: string;
  organizationId?: string;
  orderId?: string;
  provider?: string;
  providerTxnId?: string;
  customerPrice: number; // minor units
  providerCost: number; // minor units
  paymentFee?: number; // minor units
  refundCost?: number;
  fraudLoss?: number;
  currency?: string;
  source?: string;
  reason?: string;
  idempotencyKey?: string;
};

/**
 * Record a financial transaction in the ledger. Idempotent via idempotencyKey.
 * Calculates grossProfit and contributionProfit automatically.
 *
 *   grossProfit = customerPrice - providerCost
 *   contributionProfit = grossProfit - paymentFee - refundCost - fraudLoss
 */
export async function recordFinancialEvent(input: LedgerEntry): Promise<string> {
  // Idempotency: if idempotencyKey exists, return existing
  if (input.idempotencyKey) {
    const existing = await db.financialTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      logger.info("ledger.idempotent_skip", { id: existing.id, type: input.type });
      return existing.id;
    }
  }

  const customerPrice = input.customerPrice;
  const providerCost = input.providerCost;
  const paymentFee = input.paymentFee ?? 0;
  const refundCost = input.refundCost ?? 0;
  const fraudLoss = input.fraudLoss ?? 0;

  const grossProfit = customerPrice - providerCost;
  const contributionProfit = grossProfit - paymentFee - refundCost - fraudLoss;

  // The amountMinor represents the net financial impact:
  // For revenue events (CUSTOMER_PAYMENT): positive = money in
  // For cost events (PROVIDER_PURCHASE, PAYMENT_FEE): positive = money out
  // For simplicity: amountMinor = customerPrice - providerCost - paymentFee - refundCost - fraudLoss
  const amountMinor = contributionProfit;

  const txn = await db.financialTransaction.create({
    data: {
      type: input.type,
      userId: input.userId ?? null,
      organizationId: input.organizationId ?? null,
      orderId: input.orderId ?? null,
      provider: input.provider ?? null,
      providerTxnId: input.providerTxnId ?? null,
      amountMinor,
      currency: input.currency ?? "USD",
      customerPrice,
      providerCost,
      paymentFee,
      grossProfit,
      contributionProfit,
      refundCost,
      fraudLoss,
      source: input.source ?? "system",
      reason: input.reason ?? null,
      state: "settled",
      settledAt: new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  // Update provider credit account if this involves a provider purchase
  if (input.type === "PROVIDER_PURCHASE" && input.provider) {
    await increaseProviderLiability(input.provider, providerCost);
  }

  logger.info("ledger.recorded", {
    txnId: txn.id,
    type: input.type,
    customerPrice,
    providerCost,
    grossProfit,
    contributionProfit,
  });

  return txn.id;
}

/**
 * Increase a provider's outstanding liability (when we purchase from them on credit).
 */
async function increaseProviderLiability(provider: string, amountMinor: number): Promise<void> {
  const account = await db.providerCreditAccount.findUnique({ where: { provider } });
  if (!account) {
    logger.warn("ledger.provider_account_missing", { provider });
    return;
  }

  await db.providerCreditAccount.update({
    where: { id: account.id },
    data: { outstandingLiability: { increment: amountMinor } },
  });

  // Check thresholds
  const utilization = (account.outstandingLiability + amountMinor) / account.creditLimit * 100;
  if (utilization >= account.thresholdCritical) {
    logger.error("ledger.provider_credit_critical", {
      provider,
      utilization: Math.round(utilization),
      outstanding: account.outstandingLiability + amountMinor,
      limit: account.creditLimit,
    });
  } else if (utilization >= account.thresholdWarn) {
    logger.warn("ledger.provider_credit_warning", {
      provider,
      utilization: Math.round(utilization),
    });
  }
}

/** Get the financial summary for a date range. */
export async function getFinancialSummary(startDate: Date, endDate: Date) {
  const txns = await db.financialTransaction.findMany({
    where: { createdAt: { gte: startDate, lte: endDate } },
  });

  const summary = {
    totalRevenue: 0, // sum of customerPrice for CUSTOMER_PAYMENT
    totalProviderCost: 0, // sum of providerCost
    totalPaymentFees: 0,
    totalRefunds: 0,
    grossProfit: 0,
    contributionProfit: 0,
    transactionCount: txns.length,
  };

  for (const t of txns) {
    summary.totalRevenue += t.customerPrice;
    summary.totalProviderCost += t.providerCost;
    summary.totalPaymentFees += t.paymentFee;
    summary.totalRefunds += t.refundCost;
    summary.grossProfit += t.grossProfit;
    summary.contributionProfit += t.contributionProfit;
  }

  return summary;
}

/** Get all financial transactions for an order. */
export async function getOrderFinancials(orderId: string) {
  return db.financialTransaction.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
  });
}
