/**
 * Subscription service — manages recurring billing for virtual numbers.
 *
 * Lifecycle: TRIAL → ACTIVE → PAST_DUE → SUSPENDED → CANCELLED / EXPIRED
 */

import { db } from "@/lib/db";
import { getPaymentProvider, mockPaymentProvider } from "@/lib/payments";
import { spendCredit } from "@/lib/promotions/referral-service";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import { AppError } from "@/lib/errors";
import type { Currency } from "@/lib/money";

const GRACE_PERIOD_DAYS = 3;
const SUSPENSION_TO_CANCELLATION_DAYS = 7;

export type SubscriptionStatus = "trial" | "active" | "past_due" | "suspended" | "cancelled" | "expired";

export async function renewSubscription(subscriptionId: string): Promise<{
  success: boolean;
  status: SubscriptionStatus;
  newPeriodEnd?: string;
  reason?: string;
}> {
  const sub = await db.numberSubscription.findUnique({
    where: { id: subscriptionId },
    include: { virtualNumber: true },
  });
  if (!sub) throw new AppError("not_found", "Subscription not found", 404, "Subscription not found.");
  if (sub.status === "cancelled" || sub.status === "expired") {
    return { success: false, status: sub.status as SubscriptionStatus, reason: "Subscription is no longer active." };
  }

  const vn = sub.virtualNumber;
  const amount = vn.sellingPrice;
  const userId = sub.userId;

  let paidFromCredit = 0;
  try {
    paidFromCredit = await spendCredit({
      userId,
      amountMinor: amount,
      orderId: `sub_renewal_${sub.id}_${Date.now()}`,
      reason: `Subscription renewal for ${vn.e164}`,
    });
  } catch (e) {
    logger.warn("subscription.credit_spend_failed", { subId: sub.id, error: e instanceof Error ? e.message : String(e) });
  }

  const remaining = amount - paidFromCredit;

  if (remaining > 0) {
    const paymentProvider = getPaymentProvider();
    try {
      const idemKey = `sub_pay_${sub.id}_${sub.currentPeriodEnd.getTime()}`;
      const intent = await paymentProvider.createPaymentIntent({
        amountMinor: remaining,
        currency: vn.currency as Currency,
        description: `Renewal: ${vn.e164}`,
        idempotencyKey: idemKey,
        metadata: { subscriptionId: sub.id, userId, virtualNumberId: vn.id },
      });

      if (paymentProvider.isMock) {
        mockPaymentProvider.confirmIntent(intent.providerReference);
      }

      const verification = await paymentProvider.verifyPayment({
        providerReference: intent.providerReference,
        idempotencyKey: `sub_verify_${sub.id}_${Date.now()}`,
      });

      if (verification.status !== "succeeded") {
        await db.numberSubscription.update({
          where: { id: sub.id },
          data: { status: "past_due" },
        });
        await audit({ userId, action: "subscription.renewal_failed", entity: "virtual_number", entityId: vn.id, detail: { subscriptionId: sub.id } });
        logger.warn("subscription.renewal_failed", { subId: sub.id, remaining });
        return { success: false, status: "past_due", reason: "Payment failed." };
      }
    } catch (e) {
      logger.error("subscription.payment_error", { subId: sub.id, error: e instanceof Error ? e.message : String(e) });
      await db.numberSubscription.update({
        where: { id: sub.id },
        data: { status: "past_due" },
      });
      return { success: false, status: "past_due", reason: "Payment processing error." };
    }
  }

  const newPeriodEnd = new Date(sub.currentPeriodEnd);
  newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);

  await db.numberSubscription.update({
    where: { id: sub.id },
    data: { status: "active", currentPeriodEnd: newPeriodEnd },
  });

  await db.virtualNumber.update({
    where: { id: vn.id },
    data: { expiresAt: newPeriodEnd },
  });

  // Phase 2E P1 FIX: Use the CANONICAL double-entry ledger path
  // (finalizeCommercialTransaction), NOT the legacy recordFinancialEvent.
  // This converges subscription renewal onto the same financial posting
  // path as the purchase flow — one authoritative ledger.
  const { finalizeCommercialTransaction } = await import("@/lib/finance/finalize");
  const paymentFee = paidFromCredit > 0 ? 0 : Math.round(remaining * 0.029 + 30);
  await finalizeCommercialTransaction({
    orderId: `sub_renewal_${sub.id}_${sub.currentPeriodEnd.getTime()}`,
    userId,
    customerPriceMinor: amount,
    wholesalePriceMinor: vn.providerCost,
    paymentFeeMinor: paymentFee,
    currency: vn.currency,
    provider: "subscription_renewal",
    providerTxnId: vn.providerNumberId ?? undefined,
    idempotencyKey: `fin_sub_${sub.id}_${sub.currentPeriodEnd.getTime()}`,
  });

  await audit({ userId, action: "subscription.renewed", entity: "virtual_number", entityId: vn.id, detail: { subscriptionId: sub.id, newPeriodEnd } });
  logger.info("subscription.renewed", { subId: sub.id, newPeriodEnd, paidFromCredit, remaining });

  return { success: true, status: "active", newPeriodEnd: newPeriodEnd.toISOString() };
}

export async function cancelSubscription(userId: string, subscriptionId: string): Promise<void> {
  const sub = await db.numberSubscription.findUnique({
    where: { id: subscriptionId },
    include: { virtualNumber: true },
  });
  if (!sub || sub.userId !== userId) throw new AppError("not_found", "Subscription not found", 404, "Subscription not found.");

  await db.numberSubscription.update({
    where: { id: subscriptionId },
    data: { status: "cancelled", cancelledAt: new Date() },
  });

  await audit({ userId, action: "subscription.cancelled", entity: "virtual_number", entityId: sub.virtualNumberId, detail: { subscriptionId } });
  logger.info("subscription.cancelled", { subId: subscriptionId, userId });
}

export async function processDueSubscriptions(): Promise<{
  renewed: number;
  failed: number;
  suspended: number;
  cancelled: number;
}> {
  const now = new Date();
  const result = { renewed: 0, failed: 0, suspended: 0, cancelled: 0 };

  const dueActive = await db.numberSubscription.findMany({
    where: { status: "active", currentPeriodEnd: { lt: now } },
    select: { id: true },
  });

  for (const sub of dueActive) {
    const renewal = await renewSubscription(sub.id);
    if (renewal.success) result.renewed++;
    else result.failed++;
  }

  const graceCutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const pastDueToSuspend = await db.numberSubscription.findMany({
    where: { status: "past_due", currentPeriodEnd: { lt: graceCutoff } },
    select: { id: true, virtualNumberId: true },
  });

  for (const sub of pastDueToSuspend) {
    await db.numberSubscription.update({ where: { id: sub.id }, data: { status: "suspended" } });
    await db.virtualNumber.update({ where: { id: sub.virtualNumberId }, data: { status: "suspended" } });
    result.suspended++;
    logger.warn("subscription.suspended", { subId: sub.id });
  }

  const cancelCutoff = new Date(now.getTime() - SUSPENSION_TO_CANCELLATION_DAYS * 24 * 60 * 60 * 1000);
  const suspendedToCancel = await db.numberSubscription.findMany({
    where: { status: "suspended", currentPeriodEnd: { lt: cancelCutoff } },
    select: { id: true, virtualNumberId: true },
  });

  for (const sub of suspendedToCancel) {
    await db.$transaction([
      db.numberSubscription.update({ where: { id: sub.id }, data: { status: "cancelled", cancelledAt: now } }),
      db.virtualNumber.update({ where: { id: sub.virtualNumberId }, data: { status: "released", releasedAt: now } }),
    ]);
    result.cancelled++;
    logger.warn("subscription.cancelled_auto", { subId: sub.id });
  }

  if (result.renewed + result.failed + result.suspended + result.cancelled > 0) {
    logger.info("subscription.batch_processed", result);
  }

  return result;
}

export async function getUserSubscriptions(userId: string) {
  return db.numberSubscription.findMany({
    where: { userId },
    include: { virtualNumber: true },
    orderBy: { createdAt: "desc" },
  });
}
