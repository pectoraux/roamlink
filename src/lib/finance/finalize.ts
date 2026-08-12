/**
 * Finalize Commercial Transaction — the single entry point that records a
 * completed purchase as a balanced set of ledger entries.
 *
 *   finalizeCommercialTransaction({
 *     orderId, userId,
 *     customerPriceMinor,     // what the customer paid (DistributionOffer.retailPrice)
 *     wholesalePriceMinor,    // what the supplier charges (ConnectivityOffer.wholesalePrice)
 *     paymentFeeMinor,        // payment processor fee
 *     provider, providerTxnId,
 *     idempotencyKey,
 *   })
 *
 *   → posts:
 *     1. Customer payment (Cash + Payment Fees + Sales Revenue)
 *     2. Provider purchase (COGS + Provider Credit Liability)
 *
 * Idempotent via idempotencyKey prefixing (each sub-entry has its own derived
 * idempotency key, and each is independently idempotent). The whole call is
 * safe to retry.
 */

import { db } from "@/lib/db";
import {
  ledgerCustomerPayment,
  ledgerProviderPurchase,
  ensureChartOfAccounts,
} from "./double-entry-ledger";
import { logger } from "@/lib/logger";

export async function finalizeCommercialTransaction(input: {
  orderId: string;
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

  // Update the order's financialStatus to "settling" first, so concurrent
  // retries can detect in-flight finalization.
  await db.order.updateMany({
    where: { id: input.orderId, financialStatus: "pending" },
    data: { financialStatus: "settling" },
  });

  // Post customer payment (idempotent).
  const paymentTxnId = await ledgerCustomerPayment({
    userId: input.userId,
    orderId: input.orderId,
    customerPriceMinor: input.customerPriceMinor,
    paymentFeeMinor: input.paymentFeeMinor,
    currency: input.currency,
    provider: "payment", // payment processor
    providerTxnId: input.providerTxnId,
    idempotencyKey: `${input.idempotencyKey}:pay`,
  });

  // Post provider purchase (idempotent).
  const providerPurchaseTxnId = await ledgerProviderPurchase({
    userId: input.userId,
    orderId: input.orderId,
    provider: input.provider,
    providerTxnId: input.providerTxnId,
    wholesalePriceMinor: input.wholesalePriceMinor,
    currency: input.currency,
    idempotencyKey: `${input.idempotencyKey}:prov`,
  });

  // Mark the order as financially settled.
  await db.order.update({
    where: { id: input.orderId },
    data: { financialStatus: "settled" },
  });

  logger.info("finance.finalized", {
    orderId: input.orderId,
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
