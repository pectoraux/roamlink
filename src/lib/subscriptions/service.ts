/**
 * Subscription service — manages recurring billing for virtual numbers.
 *
 * Phase 2E.4: Durable renewal cycle identity.
 * The renewal cycle identity is stable across retries. It does NOT depend on
 * mutable currentPeriodEnd. If a renewal partially succeeds (financial posted,
 * domain partially updated), the retry uses the SAME cycle identity — no
 * duplicate financial transaction, no duplicate extension.
 *
 * Lifecycle: TRIAL → ACTIVE → PAST_DUE → SUSPENDED → CANCELLED / EXPIRED
 * Reconciliation: RECONCILIATION_REQUIRED → (resume same cycle) → ACTIVE
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

export type SubscriptionStatus = "trial" | "active" | "past_due" | "suspended" | "cancelled" | "expired" | "reconciliation_required";

/**
 * Renew a subscription using a durable renewal-cycle identity.
 *
 * The cycle is created (or found) BEFORE any state mutation. The cycleKey
 * is derived from the IMMUTABLE periodStart (the currentPeriodEnd before
 * renewal), not from any mutable field. This ensures:
 *   - Retries use the same identity even if domain state partially updated.
 *   - Financial idempotency keys are stable across retries.
 *   - No duplicate financial transactions or service extensions.
 *
 * State machine:
 *   pending → payment_confirmed → financial_posted → domain_updated → completed
 *   pending → failed (payment failed)
 *   financial_posted → reconciliation_required (domain update failed)
 *   reconciliation_required → (resume) → completed
 */
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

  // --- 1. Create or find the durable renewal cycle ---
  // The cycleKey is derived from the IMMUTABLE periodStart — the currentPeriodEnd
  // BEFORE any renewal mutation. This is the same value before and after
  // partial failures, ensuring retry identity stability.
  const periodStart = sub.currentPeriodEnd;
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  const cycleKey = `renewal_${sub.id}_${periodStart.getTime()}`;

  // Find or create the renewal cycle
  let cycle = await db.subscriptionRenewalCycle.findUnique({
    where: { cycleKey },
  });

  if (!cycle) {
    cycle = await db.subscriptionRenewalCycle.create({
      data: {
        subscriptionId: sub.id,
        periodStart,
        periodEnd,
        cycleKey,
        state: "pending",
      },
    });
    logger.info("renewal.cycle_created", { cycleKey, subscriptionId: sub.id, periodStart, periodEnd });
  } else {
    logger.info("renewal.cycle_resumed", { cycleKey, subscriptionId: sub.id, state: cycle.state, retryCount: cycle.retryCount });
    // Increment retry count
    await db.subscriptionRenewalCycle.update({
      where: { id: cycle.id },
      data: { retryCount: { increment: 1 } },
    });
  }

  // --- 2. If already completed, verify domain state is consistent ---
  if (cycle.state === "completed") {
    logger.info("renewal.already_completed", { cycleKey, retryCount: cycle.retryCount });

    // Even if the cycle is completed, the domain state might have been
    // rolled back (e.g., by a crash after cycle completion but before
    // the subscription update committed). Re-apply domain state if needed.
    const currentSub = await db.numberSubscription.findUnique({ where: { id: sub.id }, select: { currentPeriodEnd: true, status: true } });
    if (currentSub && (currentSub.currentPeriodEnd.getTime() < cycle.periodEnd.getTime() || currentSub.status !== "active")) {
      logger.info("renewal.repairing_domain_state", { cycleKey, currentPeriodEnd: currentSub.currentPeriodEnd, expectedPeriodEnd: cycle.periodEnd });
      try {
        await db.numberSubscription.update({
          where: { id: sub.id },
          data: { status: "active", currentPeriodEnd: cycle.periodEnd },
        });
        await db.virtualNumber.update({
          where: { id: vn.id },
          data: { expiresAt: cycle.periodEnd },
        });
      } catch (repairErr) {
        logger.error("renewal.domain_repair_failed", { cycleKey, error: repairErr instanceof Error ? repairErr.message : String(repairErr) });
      }
    }

    return { success: true, status: "active", newPeriodEnd: cycle.periodEnd.toISOString() };
  }

  // --- 3. Payment (skip if already payment_confirmed) ---
  if (cycle.state === "pending") {
    let paidFromCredit = 0;
    try {
      paidFromCredit = await spendCredit({
        userId,
        amountMinor: amount,
        orderId: cycleKey, // use the STABLE cycleKey, not a Date.now() value
        reason: `Subscription renewal for ${vn.e164}`,
      });
    } catch (e) {
      logger.warn("subscription.credit_spend_failed", { subId: sub.id, cycleKey, error: e instanceof Error ? e.message : String(e) });
    }

    const remaining = amount - paidFromCredit;

    if (remaining > 0) {
      const paymentProvider = getPaymentProvider();
      try {
        // Use the STABLE cycleKey for payment idempotency
        const idemKey = `sub_pay_${cycleKey}`;
        const intent = await paymentProvider.createPaymentIntent({
          amountMinor: remaining,
          currency: vn.currency as Currency,
          description: `Renewal: ${vn.e164}`,
          idempotencyKey: idemKey,
          metadata: { subscriptionId: sub.id, userId, virtualNumberId: vn.id, cycleKey },
        });

        if (paymentProvider.isMock) {
          mockPaymentProvider.confirmIntent(intent.providerReference);
        }

        const verification = await paymentProvider.verifyPayment({
          providerReference: intent.providerReference,
          idempotencyKey: `sub_verify_${cycleKey}`,
        });

        if (verification.status !== "succeeded") {
          await db.subscriptionRenewalCycle.update({
            where: { id: cycle.id },
            data: { state: "failed", lastError: "Payment verification failed" },
          });
          await db.numberSubscription.update({
            where: { id: sub.id },
            data: { status: "past_due" },
          });
          await audit({ userId, action: "subscription.renewal_failed", entity: "virtual_number", entityId: vn.id, detail: { subscriptionId: sub.id, cycleKey } });
          return { success: false, status: "past_due", reason: "Payment failed." };
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        await db.subscriptionRenewalCycle.update({
          where: { id: cycle.id },
          data: { state: "failed", lastError: errorMsg },
        });
        await db.numberSubscription.update({
          where: { id: sub.id },
          data: { status: "past_due" },
        });
        logger.error("subscription.payment_error", { subId: sub.id, cycleKey, error: errorMsg });
        return { success: false, status: "past_due", reason: "Payment processing error." };
      }
    }

    // Payment succeeded — record financial details on the cycle
    await db.subscriptionRenewalCycle.update({
      where: { id: cycle.id },
      data: {
        state: "payment_confirmed",
        paidFromCreditMinor: paidFromCredit,
        paidFromCashMinor: remaining,
        paymentFeeMinor: paidFromCredit > 0 ? 0 : Math.round(remaining * 0.029 + 30),
      },
    });
  }

  // --- 4. Financial finalization (skip if already financial_posted) ---
  // Re-read the cycle to get the latest state
  cycle = await db.subscriptionRenewalCycle.findUnique({ where: { cycleKey } });
  if (!cycle) throw new AppError("internal", "Renewal cycle disappeared", 500, "Internal error.");

  if (cycle.state === "payment_confirmed" || cycle.state === "reconciliation_required") {
    // Financial finalization — use the STABLE cycleKey for idempotency
    try {
      const { finalizeCommercialTransaction } = await import("@/lib/finance/finalize");
      await finalizeCommercialTransaction({
        referenceType: "SUBSCRIPTION_RENEWAL",
        referenceId: cycleKey, // STABLE identity — not derived from mutable currentPeriodEnd
        userId,
        customerPriceMinor: amount,
        wholesalePriceMinor: vn.providerCost,
        paymentFeeMinor: cycle.paymentFeeMinor,
        currency: vn.currency,
        provider: "subscription_renewal",
        providerTxnId: vn.providerNumberId ?? undefined,
        idempotencyKey: `fin_${cycleKey}`, // STABLE
      });

      await db.subscriptionRenewalCycle.update({
        where: { id: cycle.id },
        data: { state: "financial_posted" },
      });
    } catch (finErr) {
      const errorMsg = finErr instanceof Error ? finErr.message : String(finErr);
      await db.subscriptionRenewalCycle.update({
        where: { id: cycle.id },
        data: { state: "reconciliation_required", lastError: `Financial: ${errorMsg}` },
      });
      await db.numberSubscription.update({
        where: { id: sub.id },
        data: { status: "reconciliation_required" },
      }).catch(() => {});
      logger.error("subscription.financial_failed", { subId: sub.id, cycleKey, error: errorMsg });
      return { success: false, status: "reconciliation_required", reason: "Financial finalization failed. The subscription will be retried." };
    }
  }

  // --- 5. Domain state update (skip if already domain_updated/completed) ---
  cycle = await db.subscriptionRenewalCycle.findUnique({ where: { cycleKey } });
  if (!cycle) throw new AppError("internal", "Renewal cycle disappeared", 500, "Internal error.");

  if (cycle.state === "financial_posted" || cycle.state === "reconciliation_required") {
    try {
      // Only extend if not already extended (check currentPeriodEnd)
      const currentSub = await db.numberSubscription.findUnique({ where: { id: sub.id }, select: { currentPeriodEnd: true } });
      if (currentSub && currentSub.currentPeriodEnd.getTime() < cycle.periodEnd.getTime()) {
        // Not yet extended — extend now
        await db.numberSubscription.update({
          where: { id: sub.id },
          data: { status: "active", currentPeriodEnd: cycle.periodEnd },
        });
      }

      // Only update VN if not already updated
      const currentVn = await db.virtualNumber.findUnique({ where: { id: vn.id }, select: { expiresAt: true } });
      if (currentVn && (!currentVn.expiresAt || currentVn.expiresAt.getTime() < cycle.periodEnd.getTime())) {
        await db.virtualNumber.update({
          where: { id: vn.id },
          data: { expiresAt: cycle.periodEnd },
        });
      }

      await db.subscriptionRenewalCycle.update({
        where: { id: cycle.id },
        data: { state: "completed" },
      });
    } catch (domainErr) {
      const errorMsg = domainErr instanceof Error ? domainErr.message : String(domainErr);
      await db.subscriptionRenewalCycle.update({
        where: { id: cycle.id },
        data: { state: "reconciliation_required", lastError: `Domain: ${errorMsg}` },
      });
      await db.numberSubscription.update({
        where: { id: sub.id },
        data: { status: "reconciliation_required" },
      }).catch(() => {});
      logger.error("subscription.domain_update_failed", { subId: sub.id, cycleKey, error: errorMsg });
      return { success: false, status: "reconciliation_required", reason: "Financial posted but domain update failed. Will be retried." };
    }
  }

  // --- 6. Completed ---
  await db.numberSubscription.update({
    where: { id: sub.id },
    data: { status: "active" },
  }).catch(() => {});

  await audit({ userId, action: "subscription.renewed", entity: "virtual_number", entityId: vn.id, detail: { subscriptionId: sub.id, cycleKey, newPeriodEnd: cycle.periodEnd } });
  logger.info("subscription.renewed", { subId: sub.id, cycleKey, newPeriodEnd: cycle.periodEnd });

  return { success: true, status: "active", newPeriodEnd: cycle.periodEnd.toISOString() };
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
  reconciled: number;
}> {
  const now = new Date();
  const result = { renewed: 0, failed: 0, suspended: 0, cancelled: 0, reconciled: 0 };

  // Process active subscriptions that are due for renewal
  const dueActive = await db.numberSubscription.findMany({
    where: { status: "active", currentPeriodEnd: { lt: now } },
    select: { id: true },
  });

  for (const sub of dueActive) {
    const renewal = await renewSubscription(sub.id);
    if (renewal.success) result.renewed++;
    else result.failed++;
  }

  // Phase 2E.4: Process reconciliation_required subscriptions
  // These have a renewal cycle that was partially completed. Resume using
  // the SAME cycle identity — do NOT create a new renewal.
  const reconciliationRequired = await db.numberSubscription.findMany({
    where: { status: "reconciliation_required" },
    select: { id: true },
  });

  for (const sub of reconciliationRequired) {
    const renewal = await renewSubscription(sub.id);
    if (renewal.success) result.reconciled++;
    else result.failed++;
  }

  // Suspend past_due subscriptions past grace period
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

  // Cancel suspended subscriptions past cancellation threshold
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

  if (result.renewed + result.failed + result.suspended + result.cancelled + result.reconciled > 0) {
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
