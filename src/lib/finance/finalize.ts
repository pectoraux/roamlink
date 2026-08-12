/**
 * Finalize Commercial Transaction — the single entry point that records a
 * completed commercial event as a balanced set of ledger entries.
 *
 * Phase 2E.2: Refactored to be reference-type agnostic. The financial
 * finalization no longer assumes every commercial event is an Order.
 * It supports:
 *   - Order purchases (referenceType = "ORDER")
 *   - Subscription renewals (referenceType = "SUBSCRIPTION_RENEWAL")
 *   - Future recurring/usage transactions
 *
 * The caller is responsible for updating its own domain state
 * (Order.financialStatus, NumberSubscription.status, etc.) AFTER the
 * financial finalization succeeds. This prevents partial financial
 * lifecycles where the ledger is posted but the domain update fails.
 *
 *   finalizeCommercialTransaction({
 *     referenceType: "ORDER" | "SUBSCRIPTION_RENEWAL",
 *     referenceId: string,         // orderId or subscriptionRenewalId
 *     userId,
 *     customerPriceMinor,
 *     wholesalePriceMinor,
 *     paymentFeeMinor,
 *     currency, provider, providerTxnId,
 *     idempotencyKey,
 *   })
 *
 *   → posts:
 *     1. Customer payment (Dr Cash, Cr Revenue)
 *     2. Provider purchase (Dr COGS, Cr Provider Payable)
 *
 * Idempotent via idempotencyKey prefixing. Safe to retry.
 */

import { db } from "@/lib/db";
import {
  ledgerCustomerPayment,
  ledgerProviderPurchase,
  ensureChartOfAccounts,
} from "./double-entry-ledger";
import { logger } from "@/lib/logger";

export type CommercialReferenceType = "ORDER" | "SUBSCRIPTION_RENEWAL";

export async function finalizeCommercialTransaction(input: {
  /** Backward-compatible alias for referenceId (when referenceType = ORDER) */
  orderId?: string;
  /** The type of commercial event being finalized */
  referenceType?: CommercialReferenceType;
  /** The ID of the commercial reference (orderId, subscriptionRenewalId, etc.) */
  referenceId?: string;
  userId?: string;
  customerPriceMinor: number;
  wholesalePriceMinor: number;
  paymentFeeMinor: number;
  currency?: string;
  provider: string;
  providerTxnId?: string;
  idempotencyKey: string;
}): Promise<{
  paymentTxnId: string;
  providerPurchaseTxnId: string;
  financialStatus: "settled";
}> {
  await ensureChartOfAccounts();

  // Resolve the reference type and ID.
  // Backward compatibility: if only orderId is provided, treat as ORDER.
  const referenceType = input.referenceType ?? "ORDER";
  const referenceId = input.referenceId ?? input.orderId ?? "";
  if (!referenceId) {
    throw new Error("finalizeCommercialTransaction: referenceId (or orderId) is required");
  }

  // Post customer payment (idempotent).
  const paymentTxnId = await ledgerCustomerPayment({
    userId: input.userId,
    orderId: referenceId, // stored on LedgerTransaction.orderId for queryability
    customerPriceMinor: input.customerPriceMinor,
    paymentFeeMinor: input.paymentFeeMinor,
    currency: input.currency,
    provider: "payment",
    providerTxnId: input.providerTxnId,
    idempotencyKey: `${input.idempotencyKey}:pay`,
  });

  // Post provider purchase (idempotent).
  const providerPurchaseTxnId = await ledgerProviderPurchase({
    userId: input.userId,
    orderId: referenceId,
    provider: input.provider,
    providerTxnId: input.providerTxnId,
    wholesalePriceMinor: input.wholesalePriceMinor,
    currency: input.currency,
    idempotencyKey: `${input.idempotencyKey}:prov`,
  });

  // Update domain financial state — ONLY for ORDER references.
  // Subscription renewals manage their own state (NumberSubscription.status).
  // This prevents the "fake Order" problem where a synthetic ID would
  // cause db.order.update to fail.
  if (referenceType === "ORDER" && input.orderId) {
    // Only update if the order exists and isn't already settled.
    await db.order.updateMany({
      where: { id: input.orderId, financialStatus: { not: "settled" } },
      data: { financialStatus: "settled" },
    }).catch(() => {
      // Best-effort: if the order doesn't exist (shouldn't happen for ORDER type),
      // the ledger entries are still posted and idempotent.
      logger.warn("finance.order_update_skipped", { orderId: input.orderId });
    });
  }

  logger.info("finance.finalized", {
    referenceType,
    referenceId,
    paymentTxnId,
    providerPurchaseTxnId,
    customerPrice: input.customerPriceMinor,
    wholesalePrice: input.wholesalePriceMinor,
    paymentFee: input.paymentFeeMinor,
  });

  return {
    paymentTxnId,
    providerPurchaseTxnId,
    financialStatus: "settled",
  };
}
