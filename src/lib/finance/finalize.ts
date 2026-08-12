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
  /** Phase 2E.5: The portion of customerPriceMinor funded by customer credit (not cash). */
  paidFromCreditMinor?: number;
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
  const referenceType = input.referenceType ?? "ORDER";
  const referenceId = input.referenceId ?? input.orderId ?? "";
  if (!referenceId) {
    throw new Error("finalizeCommercialTransaction: referenceId (or orderId) is required");
  }

  // Post customer payment (idempotent).
  // Phase 2E.5: Pass paidFromCreditMinor so the ledger correctly distinguishes
  // cash from credit funding. Credit portion is NOT recorded as cash.
  const paymentTxnId = await ledgerCustomerPayment({
    userId: input.userId,
    orderId: referenceId,
    customerPriceMinor: input.customerPriceMinor,
    paymentFeeMinor: input.paymentFeeMinor,
    paidFromCreditMinor: input.paidFromCreditMinor,
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
  //
  // Phase 2E.3: Do NOT silently swallow errors. If the ledger is posted but
  // the Order.financialStatus update fails, we must NOT return success.
  // Instead, set the Order to "reconciliation_required" so the inconsistency
  // is visible and retriable.
  if (referenceType === "ORDER" && input.orderId) {
    const result = await db.order.updateMany({
      where: { id: input.orderId, financialStatus: { not: "settled" } },
      data: { financialStatus: "settled" },
    }).catch(async (err) => {
      // The update failed — set reconciliation_required so the inconsistency
      // is visible and retriable. Do NOT silently swallow the error.
      logger.error("finance.order_update_failed", {
        orderId: input.orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      await db.order.updateMany({
        where: { id: input.orderId },
        data: { financialStatus: "reconciliation_required" },
      }).catch(() => {}); // best-effort — if this also fails, it's in the logs
      throw new Error(`Financial finalization succeeded but Order state update failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    if (result.count === 0) {
      // The order was already settled (concurrent request) — idempotent, no-op.
      logger.info("finance.order_already_settled", { orderId: input.orderId });
    }
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
