/**
 * SaaS Subscription service — real payment lifecycle for tenant billing.
 *
 * Phase 2B.3: Implements the SaaS monetization loop.
 * Phase 2B.3.1: Financial lifecycle convergence — ledger before activation,
 *   reconciliation worker, no silent catches, durable idempotency.
 *
 * Payment model: INVOICE-STYLE RENEWAL (not automatic recurring charge).
 * Each billing period, a new payment request (PaymentIntent) is created.
 * The tenant must complete the payment (via the API or webhook). This is
 * NOT automatic recurring billing — the platform does not store payment
 * methods or charge saved cards automatically.
 *
 * To support automatic recurring billing in the future, the PaymentProvider
 * abstraction would need to be extended with:
 *   - createCustomer()
 *   - savePaymentMethod()
 *   - createRecurringCharge() / createSubscription()
 * The current model is honest about this limitation.
 *
 * Financial lifecycle:
 *   1. createSubscriptionIntent (tenant chooses plan → payment intent → pending invoice)
 *   2. confirmSubscriptionPayment (server verifies payment → posts ledger → activates)
 *   3. If ledger fails → invoice = reconciliation_required, subscription NOT activated
 *   4. processDueSaasFinancialReconciliation (cron: retries ledger for reconciliation_required)
 *   5. renewSubscription (creates new invoice + payment request for next period)
 *   6. cancelSubscription (ends at period end, no more renewals)
 *   7. processDueSaasRenewals (cron: renews subscriptions whose period has ended)
 *
 * All financial events post to the canonical double-entry ledger via
 * ledgerSaasSubscriptionPayment. SaaS revenue (4200) is separated from
 * connectivity sales revenue (4000) and platform fee revenue (4100).
 *
 * Idempotency: every operation uses a durable idempotencyKey. Subscription
 * creation checks for an existing invoice by key before creating a new provider
 * intent. Renewal uses a key derived from subscriptionId + periodEnd. Duplicate
 * webhook deliveries or cron retries cannot double-charge.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import {
  ledgerSaasSubscriptionPayment,
  ensureChartOfAccounts,
} from "@/lib/finance/double-entry-ledger";
import { getPaymentProvider, getPaymentProviderByKey } from "@/lib/payments";
import type { Currency } from "@/lib/money";

/**
 * Phase 2B.3.15 P1-3 / Phase 2B.3.16: Canonical billing-interval derivation.
 *
 * "monthly" and "yearly" are CALENDAR intervals, not fixed day counts.
 * Jan 31 + 1 month = Feb 28 (or 29 in a leap year), NOT Jan 31 + 30 days
 * and NOT Mar 3 (which is what JavaScript's naive setMonth produces due to
 * day overflow).
 *
 * Phase 2B.3.16: Billing periods are defined in UTC, not local server time.
 * All Date arithmetic uses getUTCDate/getUTCMonth/setUTCMonth/setUTCFullYear
 * to ensure the billing period is independent of the server's timezone
 * configuration. This is critical because:
 *   - paidAt is stored as a UTC timestamp in PostgreSQL
 *   - periodStart/periodEnd are stored as UTC timestamps
 *   - DST transitions in the server timezone must not shift the billing period
 *
 * This helper uses UTC calendar arithmetic WITH end-of-month clamping:
 *   - If the target month doesn't have the original day (e.g. Feb 31),
 *     clamp to the last day of the target month (Feb 28/29).
 *   - This matches the billing-period semantics used by Stripe and other
 *     billing systems: "charge on the same day each month, or the last day
 *     if that day doesn't exist."
 *
 * The billing period for a subscription is defined as:
 *   periodStart = paidAt (the financial event, UTC)
 *   periodEnd   = addBillingInterval(periodStart, billingCycle)
 *
 * Validation of an existing period MUST re-derive the expected periodEnd
 * from the recorded periodStart using this same function, then compare
 * for exact equality — NOT use a duration tolerance window.
 */
function addBillingInterval(start: Date, billingCycle: string): Date {
  const end = new Date(start.getTime());
  if (billingCycle === "yearly") {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    // monthly (default) — with end-of-month clamping in UTC.
    // JavaScript's Date.setUTCMonth overflows: Jan 31 + setUTCMonth(1) → Mar 3,
    // because it tries to create "February 31" which doesn't exist.
    // We detect the overflow and clamp to the last day of the target month.
    const originalDay = end.getUTCDate();
    end.setUTCMonth(end.getUTCMonth() + 1);
    if (end.getUTCDate() < originalDay) {
      // Day overflowed (e.g., Feb 31 → Mar 3). Clamp to the last day
      // of the target month by setting day = 0 (last day of previous month).
      end.setUTCDate(0);
    }
  }
  return end;
}

/**
 * Phase 2B.3.15 P1-3: Validate that (periodStart, periodEnd) is the canonical
 * billing interval for the given cycle. Returns true if periodEnd ===
 * addBillingInterval(periodStart, billingCycle).
 */
function isCanonicalBillingInterval(periodStart: Date, periodEnd: Date, billingCycle: string): boolean {
  const expected = addBillingInterval(periodStart, billingCycle);
  return periodEnd.getTime() === expected.getTime();
}

/**
 * Create a subscription intent for a tenant choosing a SaaS plan.
 * Creates a payment provider intent. The subscription is NOT activated until
 * the payment is verified.
 */
export async function createSubscriptionIntent(input: {
  tenantId: string;
  userId: string;
  planName: string;
  billingCycle?: "monthly" | "yearly";
  idempotencyKey: string;
}): Promise<{ subscriptionId: string; providerReference: string; status: string; clientSecret?: string }> {
  const { tenantId, userId, planName } = input;
  const billingCycle = input.billingCycle ?? "monthly";

  // Look up the plan
  const plan = await db.saaasPlan.findUnique({ where: { name: planName } });
  if (!plan) {
    throw new AppError("not_found", "SaaS plan not found", 404, `Plan "${planName}" does not exist.`);
  }
  if (plan.status !== "active") {
    throw new AppError("conflict", "Plan not available", 409, `Plan "${planName}" is not active.`);
  }
  if (plan.monthlyPriceMinor <= 0) {
    throw new AppError("validation", "Cannot subscribe to free plan", 400, "The free plan does not require a subscription. It is the default when no paid subscription exists.");
  }

  const provider = getPaymentProvider();

  // Phase 2B.3.1: Idempotency — check for an existing invoice with this idempotencyKey.
  // If found, return the existing subscription intent without creating a new provider operation.
  const existingInvoice = await db.tenantInvoice.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { subscription: true },
  });
  if (existingInvoice && existingInvoice.subscription) {
    logger.info("saas.subscribe_idempotent_replay", { idempotencyKey: input.idempotencyKey, invoiceId: existingInvoice.id });
    return {
      subscriptionId: existingInvoice.subscription.id,
      providerReference: existingInvoice.providerReference ?? "",
      status: existingInvoice.subscription.status,
    };
  }

  // Check for existing subscription
  const existing = await db.tenantSubscription.findUnique({ where: { tenantId } });
  if (existing && existing.status === "active" && existing.saaasPlanId === plan.id) {
    throw new AppError("conflict", "Already subscribed", 409, "This tenant is already on this plan.");
  }

  // Calculate the amount based on billing cycle
  const amountMinor = billingCycle === "yearly" ? plan.monthlyPriceMinor * 12 : plan.monthlyPriceMinor;

  // Create the payment intent with the provider
  const intent = await provider.createPaymentIntent({
    amountMinor,
    currency: plan.currency as Currency,
    description: `SaaS subscription: ${plan.displayName} (${billingCycle})`,
    idempotencyKey: input.idempotencyKey,
    metadata: { tenantId, planName, type: "saas_subscription" },
  });

  // Phase 2B.3.3 P0-1: Use PENDING_PAYMENT (not "trialing") for unpaid subscriptions.
  // TRIALING is reserved for actual free trials.
  // PENDING_PAYMENT subscriptions are NOT eligible for renewal processing.
  // The period is NOT set until payment is confirmed — the billing clock
  // starts when the customer pays, not when they express intent.
  const subscription = await db.tenantSubscription.upsert({
    where: { tenantId },
    create: {
      tenantId,
      saaasPlanId: plan.id,
      status: "pending_payment",
      billingCycle,
      currentPeriodEnd: new Date(0), // epoch — not a real period until payment
      paymentProvider: provider.id,
      providerReference: intent.providerReference,
    },
    update: {
      saaasPlanId: plan.id,
      status: "pending_payment",
      billingCycle,
      currentPeriodEnd: new Date(0),
      paymentProvider: provider.id,
      providerReference: intent.providerReference,
      cancelledAt: null,
      cancelReason: null,
    },
  });

  // Create a pending invoice
  await db.tenantInvoice.create({
    data: {
      tenantId,
      subscriptionId: subscription.id,
      saaasPlanName: plan.name,
      amountMinor,
      currency: plan.currency,
      billingCycle,
      // Phase 2B.3.4: No fake billing period for unpaid invoices.
      // periodStart/periodEnd are null until payment is confirmed.
      periodStart: null,
      periodEnd: null,
      status: "pending",
      paymentProvider: provider.id,
      providerReference: intent.providerReference,
      idempotencyKey: input.idempotencyKey,
    },
  });

  await audit({
    tenantId,
    userId,
    action: "saas.subscription_intent_created",
    entity: "tenant_subscription",
    entityId: subscription.id,
    detail: { planName, billingCycle, amountMinor, providerReference: intent.providerReference },
  });

  logger.info("saas.subscription_intent_created", { tenantId, subscriptionId: subscription.id, planName, providerReference: intent.providerReference });

  return {
    subscriptionId: subscription.id,
    providerReference: intent.providerReference,
    status: subscription.status,
    clientSecret: intent.clientSecret,
  };
}

/**
 * Confirm a subscription payment (server-side verification).
 * If the payment succeeded, activates the subscription + posts the ledger entry.
 * Idempotent: if already active, returns the existing state.
 */
export async function confirmSubscriptionPayment(input: {
  tenantId: string;
  userId: string;
  subscriptionId: string;
}): Promise<{ status: string }> {
  const subscription = await db.tenantSubscription.findUnique({
    where: { id: input.subscriptionId },
  });
  if (!subscription) {
    throw new AppError("not_found", "Subscription not found", 404, "Subscription not found.");
  }
  if (subscription.tenantId !== input.tenantId) {
    throw new AppError("authorization", "Cross-tenant access denied", 403, "This subscription belongs to a different tenant.");
  }

  // Idempotent: if already active, return
  if (subscription.status === "active") {
    return { status: "active" };
  }

  // Find the pending invoice
  const invoice = await db.tenantInvoice.findFirst({
    where: { subscriptionId: subscription.id, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (!invoice) {
    throw new AppError("not_found", "No pending invoice", 404, "No pending invoice found for this subscription.");
  }

  // Phase 2B.3.3 P0-2: Resolve the provider from the invoice's paymentProvider field,
  // NOT from the global getPaymentProvider(). This ensures an invoice created under
  // Provider A continues to use Provider A even if the platform's default changes.
  const provider = getPaymentProviderByKey(invoice.paymentProvider || "mock");

  // For the mock provider, simulate client-side confirmation
  if (provider.isMock && invoice.providerReference) {
    const { mockPaymentProvider } = await import("@/lib/payments");
    mockPaymentProvider.confirmIntent(invoice.providerReference);
  }

  const verification = await provider.verifyPayment({
    providerReference: invoice.providerReference!,
    idempotencyKey: invoice.idempotencyKey,
  });

  if (verification.status === "failed") {
    // Phase 2B.3.14 P0-1: GUARDED transition — never overwrite a concurrently-paid invoice.
    // The provider observation may be stale: a webhook may have finalized the invoice
    // while verifyPayment() was in flight. The mutation must be PostgreSQL-atomic:
    // only transition if the invoice is still in a pending state.
    const guarded = await db.tenantInvoice.updateMany({
      where: { id: invoice.id, status: "pending" },
      data: { status: "failed", failureReason: "Payment verification failed" },
    });
    if (guarded.count === 0) {
      // The invoice was no longer pending — a concurrent worker advanced it.
      // Re-read to understand the current state and do NOT overwrite it.
      const current = await db.tenantInvoice.findUnique({ where: { id: invoice.id }, select: { status: true } });
      logger.info("saas.confirm_failed_invoice_already_advanced", {
        invoiceId: invoice.id, currentStatus: current?.status,
      });
      // If it's now paid, the subscription should reflect that.
      if (current?.status === "paid") {
        return { status: "active" };
      }
      return { status: current?.status ?? "unknown" };
    }
    // Only transition the subscription to past_due if the invoice was actually
    // transitioned to failed (guarded).
    await db.tenantSubscription.updateMany({
      where: { id: subscription.id, status: { in: ["pending_payment", "active", "trialing"] } },
      data: { status: "past_due" },
    });
    return { status: "past_due" };
  }

  if (verification.status === "pending") {
    return { status: "pending_payment" };
  }

  // Payment succeeded — attempt financial finalization + activation.
  // Phase 2B.3.14 P1-6: Thread the provider's authoritative paidAt through.
  // Phase 2B.3.17 P0-4: Pass paymentVerified=true — verifyPayment returned "succeeded".
  const result = await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId: input.tenantId,
    userId: input.userId,
    paidAt: verification.paidAt,
    paymentVerified: true,
  });

  if (result.activated) {
    return { status: "active" };
  } else {
    // Ledger failed — invoice is reconciliation_required, subscription NOT activated
    return { status: "financial_pending" };
  }
}

/**
 * Activate the subscription and post the SaaS payment to the ledger.
 * Idempotent: status-guarded transitions.
 */
/**
 * Activate the subscription and post the SaaS payment to the ledger.
 *
 * Phase 2B.3.1: The activation order is now:
 *   1. Post the ledger entry FIRST (the canonical financial truth)
 *   2. If ledger succeeds → mark invoice as paid + activate subscription
 *   3. If ledger fails → mark invoice as reconciliation_required (do NOT activate)
 *
 * This prevents the scenario where payment succeeds, ledger fails, and the
 * subscription is falsely activated without a canonical financial record.
 * The processDueSaasFinancialReconciliation worker repairs reconciliation_required
 * invoices by retrying the ledger posting.
 *
 * Idempotent: status-guarded transitions. If already paid, returns early.
 */
async function activateSubscriptionAndPostLedger(input: {
  subscriptionId: string;
  invoiceId: string;
  tenantId: string;
  userId: string;
  /** Phase 2B.3.14 P1-6: Provider's authoritative payment timestamp. */
  paidAt?: Date;
  /**
   * Phase 2B.3.17 P0-4: Proof that the provider payment was verified.
   *
   * - `true`: the caller has verified the payment with the provider (either
   *   via verifyPayment() or via a webhook). The ledger MAY be posted for
   *   a "pending" invoice.
   * - `false` / `undefined`: the caller has NOT verified the payment. The
   *   ledger MUST NOT be posted for a "pending" invoice — only "paid" or
   *   "reconciliation_required" invoices are allowed (these states prove
   *   the payment was verified in a prior attempt).
   *
   * This guard prevents ambiguous payment states from becoming recognized
   * revenue. An invoice in "pending" status without paymentVerified=true
   * is refused — the caller must either verify the payment or use the
   * ambiguous-payment resolution path.
   */
  paymentVerified?: boolean;
}): Promise<{ activated: boolean }> {
  await ensureChartOfAccounts();

  // Get the invoice
  const invoice = await db.tenantInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) {
    throw new AppError("not_found", "Invoice not found", 404, "Invoice not found during activation.");
  }

  // Phase 2B.3.17 P0-4: GUARD — refuse to post revenue for an unverified payment.
  //
  // If the invoice is "pending" AND the caller did not provide
  // paymentVerified=true, this is an ambiguous payment state. The payment
  // was never confirmed by the provider. We MUST NOT post the ledger —
  // that would recognize revenue without proof of payment.
  //
  // The only callers that may pass paymentVerified=true are:
  //   - confirmSubscriptionPayment (after verifyPayment returns "succeeded")
  //   - handleSaasPaymentWebhook (after webhook reports "succeeded")
  //   - renewSubscription direct path (after verifyPayment returns "succeeded")
  //   - processDueSaasFinancialReconciliation stale-pending scan (after
  //     verifyPayment returns "succeeded")
  //
  // The renewal RECONCILIATION_REQUIRED path does NOT pass paymentVerified
  // because it relies on the invoice being in "reconciliation_required" status
  // (which proves the payment was verified in a prior attempt). If the invoice
  // is "pending" in that path, it means the payment was NEVER verified —
  // this is the ambiguous case, and it is refused here.
  if (invoice.status === "pending" && !input.paymentVerified) {
    logger.error("saas.activation_refused_unverified_payment", {
      invoiceId: input.invoiceId,
      invoiceStatus: invoice.status,
      hasProviderReference: !!invoice.providerReference,
      paymentVerified: input.paymentVerified ?? false,
      message: "CRITICAL: Refused to post ledger for a pending invoice without payment verification. This prevents ambiguous payment states from becoming recognized revenue.",
    });
    return { activated: false };
  }

  // Phase 2B.3.14 P1-6: Record paidAt BEFORE attempting the ledger posting.
  // This is a guarded, immutable write — only sets paidAt if it's not already set.
  // This ensures that if the ledger fails and the invoice goes to reconciliation_required,
  // paidAt is already captured from the original payment verification. On retry,
  // paidAt is preserved (not overwritten with the retry time).
  //
  // The billing period (set by activateInitialSaasSubscription) is derived from
  // this paidAt — so it reflects the actual payment time, not the recovery time.
  if (input.paidAt) {
    const paidAtResult = await db.tenantInvoice.updateMany({
      where: { id: input.invoiceId, paidAt: null, status: { in: ["pending", "reconciliation_required"] } },
      data: { paidAt: input.paidAt },
    });
    if (paidAtResult.count > 0) {
      logger.info("saas.paidAt_recorded", { invoiceId: input.invoiceId, paidAt: input.paidAt });
    }
    // If count === 0, paidAt was already set (from a prior attempt) — preserve it.
  }

  // Phase 2B.3.11 P0-2: Idempotent fast path must verify ledger existence.
  // A paid invoice with no ledgerTransactionId is a corrupted state —
  // do NOT return activated=true.
  if (invoice.status === "paid") {
    if (!invoice.ledgerTransactionId) {
      logger.error("saas.paid_invoice_missing_ledger", { invoiceId: input.invoiceId });
      await db.tenantSubscription.updateMany({
        where: { id: input.subscriptionId, status: { not: "active" } },
        data: { status: "reconciliation_required" },
      }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
      return { activated: false };
    }
    const ledgerExists = await db.ledgerTransaction.findUnique({
      where: { id: invoice.ledgerTransactionId },
      select: { id: true },
    });
    if (!ledgerExists) {
      logger.error("saas.paid_invoice_ledger_not_found", { invoiceId: input.invoiceId, ledgerTxnId: invoice.ledgerTransactionId });
      await db.tenantSubscription.updateMany({
        where: { id: input.subscriptionId, status: { not: "active" } },
        data: { status: "reconciliation_required" },
      }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
      return { activated: false };
    }

    // Phase 2B.3.11: Check if the subscription needs domain activation.
    // If it's not active yet (pending_payment or reconciliation_required),
    // perform the domain activation now.
    const currentSub = await db.tenantSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: { status: true },
    });

    if (currentSub?.status === "pending_payment" || currentSub?.status === "reconciliation_required") {
      const activationResult = await activateInitialSaasSubscription({
        invoiceId: input.invoiceId,
        subscriptionId: input.subscriptionId,
        tenantId: input.tenantId,
        userId: input.userId,
        billingCycle: invoice.billingCycle,
        ledgerTxnId: invoice.ledgerTransactionId,
        amountMinor: invoice.amountMinor,
        source: "fast_path",
      });
      if (!activationResult.activated) {
        return { activated: false };
      }
    }

    logger.info("saas.invoice_already_paid", { invoiceId: input.invoiceId });
    return { activated: true };
  }

  // If invoice is in reconciliation_required, we're retrying — that's fine.
  // If invoice is pending, this is the first attempt.
  // If invoice is failed, we should not activate.
  if (invoice.status === "failed") {
    throw new AppError("conflict", "Cannot activate a failed invoice", 409, "The invoice payment failed.");
  }

  // Step 1: Post the ledger entry FIRST (idempotent via ledger idempotencyKey)
  let ledgerTxnId: string;
  try {
    ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId: input.tenantId,
      userId: input.userId,
      amountMinor: invoice.amountMinor,
      reason: `SaaS subscription: ${invoice.saaasPlanName} (${invoice.billingCycle})`,
      idempotencyKey: `${invoice.idempotencyKey}:ledger`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("saas.ledger_posting_failed", { invoiceId: input.invoiceId, error: errorMsg });
    await db.tenantInvoice.updateMany({
      where: { id: input.invoiceId, status: { in: ["pending", "reconciliation_required"] } },
      data: { status: "reconciliation_required", failureReason: `Ledger posting failed: ${errorMsg}` },
    }).catch((updateErr) => {
      const updateMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logger.error("saas.reconciliation_status_update_failed", {
        invoiceId: input.invoiceId,
        ledgerError: errorMsg,
        updateError: updateMsg,
        message: "CRITICAL: Ledger failed AND status update to reconciliation_required failed.",
      });
    });
    return { activated: false };
  }

  // Step 2: Ledger succeeded — mark invoice as paid + link the ledger transaction.
  // Phase 2B.3.14 P1-6: Do NOT set paidAt here — it was already set guardedly above
  // (or was already set from a prior attempt). This prevents overwriting the
  // authoritative provider payment timestamp with the ledger-posting time.
  const updated = await db.tenantInvoice.updateMany({
    where: { id: input.invoiceId, status: { in: ["pending", "reconciliation_required"] } },
    data: { status: "paid", ledgerTransactionId: ledgerTxnId, failureReason: null },
  });

  if (updated.count === 0) {
    const current = await db.tenantInvoice.findUnique({ where: { id: input.invoiceId } });
    if (current?.status === "paid" && current.ledgerTransactionId) {
      logger.info("saas.invoice_concurrently_paid", { invoiceId: input.invoiceId });
      return { activated: true };
    }
    logger.warn("saas.invoice_unexpected_state", { invoiceId: input.invoiceId, status: current?.status });
    return { activated: false };
  }

  // Phase 2B.3.14 P1-6: If paidAt was not provided by the caller (e.g. webhook
  // path without provider paidAt), set it now as a fallback. This is a best-effort
  // write — if paidAt is already set (from the guarded write above), this is a no-op.
  if (!input.paidAt) {
    await db.tenantInvoice.updateMany({
      where: { id: input.invoiceId, paidAt: null },
      data: { paidAt: new Date() },
    }).catch((err) => {
      logger.error("saas.paidAt_fallback_failed", { invoiceId: input.invoiceId, error: err instanceof Error ? err.message : String(err) });
    });
  }

  // Step 3: Domain activation — for initial subscriptions only.
  // For renewals, completeSaasRenewalCycle() handles period extension.
  const currentSub = await db.tenantSubscription.findUnique({
    where: { id: input.subscriptionId },
    select: { status: true },
  });

  if (currentSub?.status === "pending_payment" || currentSub?.status === "reconciliation_required") {
    return activateInitialSaasSubscription({
      invoiceId: input.invoiceId,
      subscriptionId: input.subscriptionId,
      tenantId: input.tenantId,
      userId: input.userId,
      billingCycle: invoice.billingCycle,
      ledgerTxnId,
      amountMinor: invoice.amountMinor,
      source: "step3",
    });
  }

  // For renewals (status was already active/past_due), the caller handles
  // domain completion via completeSaasRenewalCycle().
  return { activated: true };
}

/**
 * Phase 2B.3.12: Atomic initial SaaS subscription activation.
 *
 * Performs invoice period update + subscription activation inside ONE
 * PostgreSQL transaction with FOR UPDATE locks. If either update fails,
 * the transaction rolls back — no partial activation state is committed.
 *
 * Phase 2B.3.13 — DETERMINISTIC BILLING PERIOD:
 * The initial billing period MUST be derived from a durable financial
 * timestamp captured at payment finalization (invoice.paidAt), NOT from
 * the retry execution time. Retries days apart produce the SAME period.
 *
 *   if invoice.periodStart / periodEnd already populated:
 *       reuse them           (durable recorded period — never drift)
 *   else if invoice.paidAt:
 *       periodStart = paidAt (the authoritative financial event)
 *       periodEnd   = paidAt + billingCycle
 *   else:
 *       refuse to activate   (paid invoice MUST have paidAt)
 *
 * No path inside this function may use `new Date()` for the period start.
 *
 * Phase 2B.3.13 — LEDGER INVARIANT ENFORCED IN THE HELPER:
 * This function does NOT trust callers for the ledger-existence invariant.
 * It verifies `LedgerTransaction` exists for invoice.ledgerTransactionId
 * inside the same transaction. The authoritative activation function cannot
 * ever be called with a dangling ledger reference.
 *
 * If the transaction fails, marks the subscription reconciliation_required
 * so the worker can retry. The financial state (invoice paid + ledger)
 * remains intact — only the domain activation is retried. On retry, the
 * billing period is recomputed identically (from paidAt).
 */
async function activateInitialSaasSubscription(input: {
  invoiceId: string;
  subscriptionId: string;
  tenantId: string;
  userId: string;
  billingCycle: string;
  ledgerTxnId: string;
  amountMinor: number;
  source: string; // "fast_path" | "step3"
}): Promise<{ activated: boolean }> {
  try {
    type ActivationResult = {
      activated: boolean;
      reason: string;
      periodStart?: Date;
      periodEnd?: Date;
      periodSource?: "reused" | "paidAt" | "validated";
    };
    const result: ActivationResult = await db.$transaction(async (tx) => {
      // 1. Lock the invoice — Phase 2B.3.13: also load paidAt + existing periods
      //    so the billing period can be derived deterministically.
      const lockedInvoice: Array<{ id: string; status: string; ledgerTransactionId: string | null; paidAt: Date | null; periodStart: Date | null; periodEnd: Date | null }> = await tx.$queryRaw`
        SELECT id, status, "ledgerTransactionId", "paidAt", "periodStart", "periodEnd"
        FROM "TenantInvoice"
        WHERE id = ${input.invoiceId}
        FOR UPDATE
      `;
      if (lockedInvoice.length === 0) {
        return { activated: false, reason: "Invoice not found" };
      }
      const inv = lockedInvoice[0];

      // 2. Lock the subscription
      const lockedSub: Array<{ id: string; status: string }> = await tx.$queryRaw`
        SELECT id, status
        FROM "TenantSubscription"
        WHERE id = ${input.subscriptionId}
        FOR UPDATE
      `;
      if (lockedSub.length === 0) {
        return { activated: false, reason: "Subscription not found" };
      }
      const sub = lockedSub[0];

      // 3. Verify prerequisites — invoice must be paid AND have a ledger reference.
      if (inv.status !== "paid" || !inv.ledgerTransactionId) {
        return { activated: false, reason: `Invoice not ready (status: ${inv.status})` };
      }

      // 3b. Phase 2B.3.13 P1: Verify the referenced LedgerTransaction ACTUALLY EXISTS
      // inside the helper itself. Do not rely on callers to establish this invariant.
      const ledgerCheck: Array<{ id: string }> = await tx.$queryRaw`
        SELECT id FROM "LedgerTransaction" WHERE id = ${inv.ledgerTransactionId}
      `;
      if (ledgerCheck.length === 0) {
        return { activated: false, reason: "Ledger transaction referenced by invoice does not exist (dangling reference)" };
      }

      // 4. Only activate if subscription is pending_payment or reconciliation_required
      if (sub.status !== "pending_payment" && sub.status !== "reconciliation_required") {
        // Already active — idempotent success
        return { activated: true, reason: "already_active" };
      }

      // 5. Phase 2B.3.13/2B.3.14/2B.3.15: Derive billing period DETERMINISTICALLY.
      //    The billing clock starts when the customer pays — never when a
      //    recovery worker happens to repair the domain state.
      let periodStart: Date;
      let periodEnd: Date;
      let periodSource: "reused" | "paidAt" | "validated";
      if (inv.periodStart && inv.periodEnd) {
        // Phase 2B.3.15 P1-3: VALIDATE the existing period using CANONICAL CALENDAR
        // intervals — NOT duration tolerances. "monthly" is a calendar month
        // (Jan 31 → Feb 28), not 30 days. We re-derive the expected periodEnd
        // from periodStart using addBillingInterval(), then compare exactly.
        const ps = inv.periodStart;
        const pe = inv.periodEnd;

        // 5a. Temporal sanity: periodEnd must be after periodStart.
        if (pe.getTime() <= ps.getTime()) {
          logger.error("saas.existing_period_invalid_duration", {
            invoiceId: input.invoiceId, periodStart: ps, periodEnd: pe,
          });
          return { activated: false, reason: "Existing invoice period is invalid (periodEnd <= periodStart)" };
        }

        // 5b. Phase 2B.3.15 P1-3: Canonical calendar validation.
        // Re-derive expected periodEnd from periodStart using the same calendar
        // arithmetic used to create it. If they don't match exactly, the recorded
        // period is corrupt.
        if (!isCanonicalBillingInterval(ps, pe, input.billingCycle)) {
          logger.error("saas.existing_period_not_canonical", {
            invoiceId: input.invoiceId, billingCycle: input.billingCycle,
            periodStart: ps, periodEnd: pe,
            expected: addBillingInterval(ps, input.billingCycle),
          });
          return { activated: false, reason: `Existing period is not the canonical ${input.billingCycle} billing interval for the recorded periodStart` };
        }

        // 5c. If paidAt is available, verify periodStart is consistent with it.
        // For initial subscriptions, periodStart should equal paidAt (the financial event).
        // If they differ significantly, the recorded period may be corrupt.
        if (inv.paidAt) {
          const diffMs = Math.abs(ps.getTime() - inv.paidAt.getTime());
          const diffDays = diffMs / 86400000;
          if (diffDays > 1) {
            // periodStart doesn't match paidAt — fall through to paidAt derivation
            // rather than reusing the inconsistent period. This is a repair, not a refusal.
            logger.warn("saas.existing_period_inconsistent_with_paidAt", {
              invoiceId: input.invoiceId, periodStart: ps, paidAt: inv.paidAt, diffDays: diffDays.toFixed(1),
              message: "Existing periodStart doesn't match paidAt — re-deriving from paidAt.",
            });
            periodStart = inv.paidAt;
            periodEnd = addBillingInterval(periodStart, input.billingCycle);
            periodSource = "validated";
          } else {
            periodStart = ps;
            periodEnd = pe;
            periodSource = "reused";
          }
        } else {
          // No paidAt to compare against — reuse the recorded period (calendar shape was validated).
          periodStart = ps;
          periodEnd = pe;
          periodSource = "reused";
        }
      } else if (inv.paidAt) {
        // First activation — anchor to the financial event that created the subscription.
        // Phase 2B.3.15 P1-3: Use addBillingInterval for canonical calendar derivation.
        periodStart = inv.paidAt;
        periodEnd = addBillingInterval(periodStart, input.billingCycle);
        periodSource = "paidAt";
      } else {
        // Defensive — a paid invoice MUST have paidAt. If missing, the schema is corrupt;
        // refuse to activate rather than fabricate a billing period.
        return { activated: false, reason: "Paid invoice has no paidAt timestamp (cannot derive billing period)" };
      }

      // 6. Update invoice period (idempotent — same input produces same row)
      await tx.tenantInvoice.update({
        where: { id: input.invoiceId },
        data: { periodStart, periodEnd },
      });

      // 7. Activate the subscription
      await tx.tenantSubscription.update({
        where: { id: input.subscriptionId },
        data: { status: "active", currentPeriodEnd: periodEnd },
      });

      return { activated: true, reason: "activated", periodStart, periodEnd, periodSource };
    }, { timeout: 30000, maxWait: 15000 });

    if (result.activated) {
      await audit({
        tenantId: input.tenantId,
        userId: (input.userId === "renewal-worker" || input.userId === "webhook" || input.userId === "reconciliation-worker") ? undefined : input.userId,
        action: "saas.subscription_activated",
        entity: "tenant_subscription",
        entityId: input.subscriptionId,
        // Phase 2B.3.13: persist periodSource ("paidAt" | "reused") so auditors
        // can prove the billing period was derived from the financial event,
        // not the retry execution time.
        detail: {
          invoiceId: input.invoiceId,
          ledgerTxnId: input.ledgerTxnId,
          amount: input.amountMinor,
          source: input.source,
          periodSource: result.periodSource,
          periodStart: result.periodStart?.toISOString(),
          periodEnd: result.periodEnd?.toISOString(),
        },
      });
      logger.info("saas.subscription_activated", {
        tenantId: input.tenantId, subscriptionId: input.subscriptionId,
        ledgerTxnId: input.ledgerTxnId, invoiceId: input.invoiceId, source: input.source,
        periodSource: result.periodSource,
      });
      return { activated: true };
    } else {
      logger.warn("saas.initial_activation_skipped", {
        subscriptionId: input.subscriptionId, invoiceId: input.invoiceId,
        reason: result.reason, source: input.source,
      });
      return { activated: false };
    }
  } catch (err) {
    // Transaction failed — neither invoice period nor subscription was updated.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("saas.initial_activation_failed", {
      subscriptionId: input.subscriptionId,
      invoiceId: input.invoiceId,
      tenantId: input.tenantId,
      error: errorMsg,
      source: input.source,
      message: "CRITICAL: Financial finalization succeeded but domain activation failed (transactional). Subscription marked reconciliation_required.",
    });
    // Mark for recovery
    await db.tenantSubscription.updateMany({
      where: { id: input.subscriptionId, status: { not: "active" } },
      data: { status: "reconciliation_required" },
    }).catch((updateErr) => {
      logger.error("saas.recovery_state_persist_failed", {
        subscriptionId: input.subscriptionId,
        tenantId: input.tenantId,
        originalError: errorMsg,
        persistError: updateErr instanceof Error ? updateErr.message : String(updateErr),
        message: "CRITICAL: Failed to persist reconciliation_required after activation failure. The stale-status scan will recover it.",
      });
    });
    return { activated: false };
  }
}

/**
 * Phase 2B.3.7: Complete a SaaS renewal cycle — the SINGLE authoritative
 * function that extends the subscription period after financial finalization.
 *
 * This function is called by ALL successful renewal paths:
 *   - renewSubscription (direct path)
 *   - handleSaasPaymentWebhook (webhook path)
 *   - processDueSaasFinancialReconciliation (reconciliation path)
 *
 * Phase 2B.3.7: The cycle completion + subscription period extension are
 * performed inside ONE PostgreSQL transaction with FOR UPDATE locks on both
 * the SaasRenewalCycle and TenantSubscription rows. This guarantees:
 *
 *   IF cycle = COMPLETED
 *   THEN subscription.currentPeriodEnd = cycle.periodEnd
 *
 * No partial completion is possible. If the subscription update fails,
 * the transaction rolls back and the cycle does NOT become COMPLETED.
 *
 * Idempotent: if already COMPLETED, verifies currentPeriodEnd == cycle.periodEnd.
 * If they differ (stale legacy state), repairs the subscription period
 * inside a new transaction.
 */
async function completeSaasRenewalCycle(input: {
  invoiceId: string;
  tenantId: string;
}): Promise<{ completed: boolean }> {
  // Find the renewal cycle linked to this invoice (read-only, outside transaction)
  const cycle = await db.saasRenewalCycle.findFirst({
    where: { invoiceId: input.invoiceId },
  });
  if (!cycle) {
    // No cycle — this is an initial subscription, not a renewal. Nothing to complete.
    return { completed: false };
  }

  try {
    // Phase 2B.3.7: Perform the completion inside ONE transaction with row locks.
    const result = await db.$transaction(async (tx) => {
      // 1. Lock the SaasRenewalCycle row
      const lockedCycle: Array<{ id: string; state: string; subscriptionId: string; periodEnd: Date; invoiceId: string | null }> = await tx.$queryRaw`
        SELECT id, state, "subscriptionId", "periodEnd", "invoiceId"
        FROM "SaasRenewalCycle"
        WHERE id = ${cycle.id}
        FOR UPDATE
      `;
      if (lockedCycle.length === 0) {
        return { completed: false, reason: "Cycle not found" };
      }
      const c = lockedCycle[0];

      // 2. Lock the TenantSubscription row
      const lockedSub: Array<{ id: string; currentPeriodEnd: Date; status: string }> = await tx.$queryRaw`
        SELECT id, "currentPeriodEnd", status
        FROM "TenantSubscription"
        WHERE id = ${c.subscriptionId}
        FOR UPDATE
      `;
      if (lockedSub.length === 0) {
        return { completed: false, reason: "Subscription not found" };
      }
      const sub = lockedSub[0];

      // 3. If already COMPLETED, verify the invariant. Repair if stale.
      if (c.state === "COMPLETED") {
        if (sub.currentPeriodEnd.getTime() === c.periodEnd.getTime()) {
          // Invariant holds — idempotent success
          return { completed: true, reason: "already_completed" };
        }
        // Stale legacy state: cycle says COMPLETED but period wasn't extended.
        // Repair inside this transaction.
        logger.warn("saas.cycle_stale_repairing", {
          cycleId: c.id,
          currentPeriodEnd: sub.currentPeriodEnd,
          expectedPeriodEnd: c.periodEnd,
        });
        await tx.tenantSubscription.update({
          where: { id: c.subscriptionId },
          data: { status: "active", currentPeriodEnd: c.periodEnd },
        });
        return { completed: true, reason: "stale_repaired" };
      }

      // 4. Verify the invoice is financially ready (paid + ledger exists)
      if (!c.invoiceId) {
        return { completed: false, reason: "No invoice linked to cycle" };
      }
      const invoice = await tx.tenantInvoice.findUnique({
        where: { id: c.invoiceId },
        select: { status: true, ledgerTransactionId: true },
      });
      if (!invoice || invoice.status !== "paid" || !invoice.ledgerTransactionId) {
        return { completed: false, reason: `Invoice not ready (status: ${invoice?.status})` };
      }

      // Phase 2B.3.14 P1-7: Verify the referenced LedgerTransaction ACTUALLY EXISTS
      // inside the helper's own transaction — symmetric with activateInitialSaasSubscription.
      // The authoritative completion function must NOT trust a non-null ledgerTransactionId
      // without proving the row exists.
      const ledgerCheck: Array<{ id: string }> = await tx.$queryRaw`
        SELECT id FROM "LedgerTransaction" WHERE id = ${invoice.ledgerTransactionId}
      `;
      if (ledgerCheck.length === 0) {
        logger.error("saas.cycle_completion_dangling_ledger", {
          cycleId: c.id, invoiceId: c.invoiceId, ledgerTxnId: invoice.ledgerTransactionId,
        });
        return { completed: false, reason: "Ledger transaction referenced by invoice does not exist (dangling reference)" };
      }

      // 5. Update the subscription period FIRST (before marking cycle COMPLETED)
      await tx.tenantSubscription.update({
        where: { id: c.subscriptionId },
        data: {
          status: "active",
          currentPeriodEnd: c.periodEnd,
        },
      });

      // 6. Mark the cycle COMPLETED (after subscription update succeeds)
      // Status-guarded: only non-COMPLETED → COMPLETED
      await tx.saasRenewalCycle.updateMany({
        where: { id: c.id, state: { not: "COMPLETED" } },
        data: { state: "COMPLETED", failureReason: null },
      });

      return { completed: true, reason: "completed" };
    }, { timeout: 30000, maxWait: 15000 });

    if (result.completed) {
      if (result.reason === "stale_repaired") {
        logger.info("saas.cycle_stale_repaired", { cycleId: cycle.id });
      } else if (result.reason !== "already_completed") {
        logger.info("saas.renewal_cycle_completed", {
          cycleId: cycle.id,
          subscriptionId: cycle.subscriptionId,
          newPeriodEnd: cycle.periodEnd,
        });
      } else {
        logger.info("saas.cycle_already_completed", { cycleId: cycle.id });
      }
    } else {
      logger.warn("saas.cycle_not_completed", { cycleId: cycle.id, reason: result.reason });
    }

    return { completed: result.completed };
  } catch (err) {
    // Transaction failed — neither the cycle nor the subscription was updated
    logger.error("saas.cycle_completion_failed", {
      cycleId: cycle.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { completed: false };
  }
}

/**
 * Cancel a subscription. The subscription remains active until the end of the
 * current period, then expires. No more renewals.
 */
export async function cancelSubscription(input: {
  tenantId: string;
  userId: string;
  reason?: string;
}): Promise<{ status: string; currentPeriodEnd: Date }> {
  const subscription = await db.tenantSubscription.findUnique({
    where: { tenantId: input.tenantId },
  });
  if (!subscription) {
    throw new AppError("not_found", "No subscription found", 404, "This tenant has no subscription.");
  }

  // Phase 2B.3.14 P2-10: Guard cancellation against financial recovery states.
  // A subscription in reconciliation_required has a paid invoice + posted ledger
  // that is awaiting domain activation. Cancelling it would orphan the financial
  // state with no recovery path.
  if (subscription.status === "reconciliation_required") {
    throw new AppError(
      "conflict",
      "Cannot cancel subscription in recovery state",
      409,
      "This subscription has a pending financial reconciliation. Wait for the reconciliation worker to complete before cancelling, or contact support.",
    );
  }

  // Phase 2B.3.14 P2-10: Guarded transition — only cancel if not already cancelled.
  const result = await db.tenantSubscription.updateMany({
    where: { id: subscription.id, status: { not: "cancelled" } },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: input.reason ?? null,
    },
  });
  if (result.count === 0) {
    // Already cancelled — idempotent
    return { status: "cancelled", currentPeriodEnd: subscription.currentPeriodEnd };
  }

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "saas.subscription_cancelled",
    entity: "tenant_subscription",
    entityId: subscription.id,
    detail: { reason: input.reason },
  });

  logger.info("saas.subscription_cancelled", { tenantId: input.tenantId, subscriptionId: subscription.id });

  return { status: "cancelled", currentPeriodEnd: subscription.currentPeriodEnd };
}

/**
 * Renew a subscription for the next billing period.
 * Creates an invoice + payment intent + charges.
 *
 * Idempotent: uses a durable renewalIdempotencyKey derived from the
 * subscription ID + period end. Duplicate cron calls or webhook retries
 * cannot double-charge.
 */
export async function renewSubscription(tenantId: string): Promise<{ success: boolean; status: string; reason?: string }> {
  const subscription = await db.tenantSubscription.findUnique({
    where: { tenantId },
    include: { saaasPlan: true },
  });
  if (!subscription) {
    return { success: false, status: "none", reason: "No subscription found" };
  }

  // Don't renew cancelled subscriptions
  if (subscription.status === "cancelled") {
    return { success: false, status: "cancelled", reason: "Subscription is cancelled" };
  }

  // Phase 2B.3.14 P2-13: Don't renew free plans through the paid SaaS machinery.
  // Free plans have monthlyPriceMinor = 0 — the ledger rejects zero-amount
  // transactions, and there's no payment to process. Free-plan subscriptions
  // should be handled by a separate product-level flow, not the payment pipeline.
  if (subscription.saaasPlan && subscription.saaasPlan.monthlyPriceMinor <= 0) {
    logger.info("saas.free_plan_renewal_skipped", { tenantId, planName: subscription.saaasPlan.name });
    // Extend the period without payment/ledger — free plan.
    // Phase 2B.3.15 P1-3: Use addBillingInterval for canonical calendar derivation.
    const newPeriodEnd = addBillingInterval(subscription.currentPeriodEnd, subscription.billingCycle);
    await db.tenantSubscription.updateMany({
      where: { id: subscription.id, status: { in: ["active", "past_due"] } },
      data: { status: "active", currentPeriodEnd: newPeriodEnd },
    });
    return { success: true, status: "active" };
  }

  // Don't renew if the current period hasn't ended yet
  if (subscription.currentPeriodEnd > new Date()) {
    return { success: false, status: subscription.status, reason: "Current period has not ended" };
  }

  const plan = subscription.saaasPlan;
  const amountMinor = subscription.billingCycle === "yearly" ? plan.monthlyPriceMinor * 12 : plan.monthlyPriceMinor;

  // Phase 2B.3.5: Derive the durable cycle identity from immutable periodStart.
  // The cycleKey is subscriptionId + immutable periodStart (the expired period's end).
  // This is the SAME key regardless of how many workers run concurrently.
  // Phase 2B.3.15 P1-3: Use addBillingInterval for canonical calendar derivation.
  const newPeriodStart = subscription.currentPeriodEnd;
  const newPeriodEnd = addBillingInterval(newPeriodStart, subscription.billingCycle);

  const cycleKey = `saas_renewal_${subscription.id}_${newPeriodStart.getTime()}`;

  // Phase 2B.3.5: Atomically get-or-create the SaasRenewalCycle.
  // The unique constraint on cycleKey ensures two concurrent workers
  // resolve to the SAME cycle.
  let cycle = await db.saasRenewalCycle.findUnique({ where: { cycleKey } });
  if (!cycle) {
    try {
      cycle = await db.saasRenewalCycle.create({
        data: {
          subscriptionId: subscription.id,
          tenantId,
          cycleKey,
          state: "PENDING",
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        },
      });
      logger.info("saas.renewal_cycle_created", { cycleId: cycle.id, cycleKey, subscriptionId: subscription.id });
    } catch (err: any) {
      // P2002 = another concurrent worker created it. Re-fetch.
      if (err?.code === "P2002") {
        cycle = await db.saasRenewalCycle.findUnique({ where: { cycleKey } });
        logger.info("saas.renewal_cycle_existing", { cycleId: cycle?.id, cycleKey });
      } else {
        throw err;
      }
    }
  }
  if (!cycle) {
    return { success: false, status: "error", reason: "Failed to create/find renewal cycle" };
  }

  // Phase 2B.3.9: If the cycle is already COMPLETED, do NOT blindly return success.
  // Route through completeSaasRenewalCycle() which verifies the invariant
  // (subscription.currentPeriodEnd == cycle.periodEnd) and repairs if stale.
  if (cycle.state === "COMPLETED") {
    if (!cycle.invoiceId) {
      // COMPLETED cycle with no invoice — fail closed, don't silently succeed
      logger.error("saas.completed_cycle_no_invoice", { cycleId: cycle.id });
      return { success: false, status: "error", reason: "Completed cycle has no invoice — manual reconciliation required" };
    }
    const completion = await completeSaasRenewalCycle({ invoiceId: cycle.invoiceId, tenantId });
    if (completion.completed) {
      return { success: true, status: "active" };
    } else {
      return { success: false, status: "error", reason: "Completed cycle invariant verification failed" };
    }
  }

  // Phase 2B.3.17 P0-1/P0-3: AMBIGUOUS_PAYMENT is a separate state from
  // RECONCILIATION_REQUIRED. It represents a payment-operation creation that
  // timed out without a providerReference — the payment may or may not exist
  // at the provider. It MUST NOT be fed into activateSubscriptionAndPostLedger(),
  // because that would post revenue without proof of payment.
  if (cycle.state === "AMBIGUOUS_PAYMENT") {
    logger.error("saas.renewal_refused_ambiguous_payment", {
      cycleId: cycle.id, tenantId, subscriptionId: subscription.id,
      message: "CRITICAL: Renewal refused for AMBIGUOUS_PAYMENT cycle. This state requires manual/provider audit to determine whether a payment operation was created. Revenue must NOT be recognized until the ambiguity is resolved.",
    });
    return {
      success: false,
      status: "error",
      reason: "Cycle is in AMBIGUOUS_PAYMENT state — manual/provider audit required before renewal can proceed",
    };
  }

  // If the cycle is RECONCILIATION_REQUIRED, attempt to finalize the existing invoice.
  // Phase 2B.3.17 P0-4: This path does NOT pass paymentVerified=true.
  // The guard inside activateSubscriptionAndPostLedger() will refuse to post
  // the ledger if the invoice is "pending" (unverified). Only invoices in
  // "reconciliation_required" or "paid" status are allowed — these prove the
  // payment was verified in a prior attempt.
  if (cycle.state === "RECONCILIATION_REQUIRED" || cycle.state === "FINANCIAL_POSTED") {
    if (!cycle.invoiceId) {
      return { success: false, status: "error", reason: "Cycle in financial state but no invoice" };
    }
    // Phase 2B.3.17 P0-4: paymentVerified is intentionally NOT passed here.
    // If the invoice is "pending", the guard refuses the ledger posting.
    const result = await activateSubscriptionAndPostLedger({
      subscriptionId: subscription.id,
      invoiceId: cycle.invoiceId,
      tenantId,
      userId: "renewal-worker",
    });

    if (result.activated) {
      // Phase 2B.3.10: Use the single authoritative completion function.
      // If completion fails, mark cycle RECONCILIATION_REQUIRED for recovery.
      const completion = await completeSaasRenewalCycle({ invoiceId: cycle.invoiceId!, tenantId });
      if (completion.completed) {
        return { success: true, status: "active" };
      } else {
        await db.saasRenewalCycle.updateMany({
          where: { id: cycle.id, state: { not: "COMPLETED" } },
          data: { state: "RECONCILIATION_REQUIRED", failureReason: "Period extension failed during renewal retry" },
        }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
        return { success: false, status: "financial_pending", reason: "Period extension failed during renewal retry" };
      }
    } else {
      return { success: false, status: "financial_pending", reason: "Ledger posting still failing during renewal retry" };
    }
  }

  // If the cycle is PAST_DUE (payment failed), don't retry automatically.
  if (cycle.state === "PAST_DUE") {
    return { success: false, status: "past_due", reason: "Renewal payment previously failed" };
  }

  // Cycle is PENDING or PAYMENT_PENDING — proceed with the renewal.
  // Use the invoice idempotency key derived from the cycle identity.
  const renewalKey = cycleKey;

  // Check if an invoice already exists for this cycle
  const existingInvoice = cycle.invoiceId
    ? await db.tenantInvoice.findUnique({ where: { id: cycle.invoiceId } })
    : await db.tenantInvoice.findUnique({ where: { idempotencyKey: renewalKey } });

  if (existingInvoice && existingInvoice.status === "paid") {
    // Phase 2B.3.8: Use the single authoritative completion function.
    // NO direct cycle/subscription mutation outside completeSaasRenewalCycle().
    if (!cycle.invoiceId) {
      // Phase 2B.3.14 P2-12: Guarded — only update invoiceId if not already set.
      await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, invoiceId: null },
        data: { invoiceId: existingInvoice.id },
      });
    }
    const completion = await completeSaasRenewalCycle({ invoiceId: existingInvoice.id, tenantId });
    if (completion.completed) {
      return { success: true, status: "active" };
    } else {
      // Phase 2B.3.10: Mark cycle for recovery
      await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, state: { not: "COMPLETED" } },
        data: { state: "RECONCILIATION_REQUIRED", failureReason: "Completion failed for already-paid invoice" },
      }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
      return { success: false, status: "financial_pending", reason: "Completion failed for already-paid invoice" };
    }
  }

  // Create or reuse the invoice
  const invoice = await db.tenantInvoice.upsert({
    where: { idempotencyKey: renewalKey },
    create: {
      tenantId,
      subscriptionId: subscription.id,
      saaasPlanName: plan.name,
      amountMinor,
      currency: plan.currency,
      billingCycle: subscription.billingCycle,
      periodStart: newPeriodStart,
      periodEnd: newPeriodEnd,
      status: "pending",
      idempotencyKey: renewalKey,
    },
    update: {},
  });

  // Link the invoice to the cycle + transition to PAYMENT_PENDING.
  // Phase 2B.3.14 P2-12: Guarded — don't overwrite COMPLETED or RECONCILIATION_REQUIRED.
  await db.saasRenewalCycle.updateMany({
    where: { id: cycle.id, state: { notIn: ["COMPLETED", "RECONCILIATION_REQUIRED", "PAYMENT_PENDING"] } },
    data: { state: "PAYMENT_PENDING", invoiceId: invoice.id },
  });

  if (invoice.status === "paid") {
    // Phase 2B.3.10: Use the single authoritative completion function.
    const completion = await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId });
    if (completion.completed) {
      return { success: true, status: "active" };
    } else {
      await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, state: { not: "COMPLETED" } },
        data: { state: "RECONCILIATION_REQUIRED", failureReason: "Completion failed for paid invoice" },
      }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
      return { success: false, status: "financial_pending", reason: "Completion failed for paid invoice" };
    }
  }

  // If the invoice is reconciliation_required, attempt to finalize
  if (invoice.status === "reconciliation_required") {
    await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: { notIn: ["COMPLETED", "RECONCILIATION_REQUIRED"] } },
      data: { state: "FINANCIAL_POSTED" },
    });
    const result = await activateSubscriptionAndPostLedger({
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      tenantId,
      userId: "renewal-worker",
    });

    if (result.activated) {
      // Phase 2B.3.10: Use the single authoritative completion function.
      const completion = await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId });
      if (completion.completed) {
        return { success: true, status: "active" };
      } else {
        await db.saasRenewalCycle.updateMany({
          where: { id: cycle.id, state: { not: "COMPLETED" } },
          data: { state: "RECONCILIATION_REQUIRED", failureReason: "Period extension failed" },
        }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
        return { success: false, status: "financial_pending", reason: "Period extension failed" };
      }
    } else {
      await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, state: { not: "COMPLETED" } },
        data: { state: "RECONCILIATION_REQUIRED" },
      });
      return { success: false, status: "financial_pending", reason: "Ledger posting still failing during renewal retry" };
    }
  }

  // Phase 2B.3.3: Use the subscription's stored payment provider.
  // Phase 2B.3.16: ATOMIC PAYMENT-OPERATION ACQUISITION.
  //
  // The previous code (2B.3.15) had a race: two concurrent workers could both
  // read providerReference = null, both call createPaymentIntent(), and both
  // try to persist. The invariant "ONE INVOICE → ONE PROVIDER PAYMENT OPERATION"
  // relied entirely on provider-level idempotency.
  //
  // This fix introduces a durable payment-operation state machine at the
  // APPLICATION level, using the SaasRenewalCycle's state field:
  //
  //   PAYMENT_PENDING → PAYMENT_CREATING → PAYMENT_CONFIRMED
  //
  // The transition PAYMENT_PENDING → PAYMENT_CREATING is a PostgreSQL-atomic
  // conditional mutation (updateMany WHERE state = 'PAYMENT_PENDING'). Only
  // ONE worker can win this claim. The winner calls createPaymentIntent and
  // persists the providerReference. Losers re-read and reuse the reference.
  //
  // Crash recovery: if the winner crashes after claiming PAYMENT_CREATING but
  // before persisting the providerReference, the cycle is stuck in
  // PAYMENT_CREATING. The reconciliation worker scans for cycles stuck in
  // PAYMENT_CREATING for > 5 minutes and re-claims them (see
  // processDueSaasFinancialReconciliation).
  //
  // This does NOT eliminate provider-level idempotency as a defense — it
  // adds an APPLICATION-LEVEL guarantee that only one worker calls
  // createPaymentIntent, without relying on the provider to deduplicate.
  const provider = getPaymentProviderByKey(subscription.paymentProvider || "mock");
  let providerReference: string;

  // Re-read the invoice to get the current providerReference.
  const currentInvoice = await db.tenantInvoice.findUnique({
    where: { id: invoice.id },
    select: { providerReference: true, paymentProvider: true },
  });

  if (currentInvoice?.providerReference) {
    // Reuse the existing provider operation — never create a second one.
    providerReference = currentInvoice.providerReference;
    logger.info("saas.renewal_reusing_provider_reference", {
      invoiceId: invoice.id, cycleId: cycle.id, providerReference,
    });
  } else {
    // Phase 2B.3.16: ATOMIC CLAIM — transition cycle to PAYMENT_CREATING.
    // Only the worker that successfully transitions PAYMENT_PENDING →
    // PAYMENT_CREATING may call createPaymentIntent. This is a
    // PostgreSQL-atomic conditional mutation.
    const claim = await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: "PAYMENT_PENDING" },
      data: { state: "PAYMENT_CREATING" },
    });

    if (claim.count === 0) {
      // Another worker is already creating the payment operation (cycle is in
      // PAYMENT_CREATING) or has already moved past it. We must NOT call
      // createPaymentIntent. Wait briefly for the winner to persist the
      // providerReference, then re-read and reuse it.
      logger.info("saas.payment_creation_claim_lost", {
        cycleId: cycle.id, invoiceId: invoice.id,
      });

      // Wait up to 10 seconds (polling every 500ms) for the providerReference
      // to appear. If it doesn't appear, return financial_pending — the
      // reconciliation worker will recover the stuck cycle.
      let waited = 0;
      let ref: string | null = null;
      while (waited < 10000) {
        await new Promise((r) => setTimeout(r, 500));
        waited += 500;
        const reRead = await db.tenantInvoice.findUnique({
          where: { id: invoice.id },
          select: { providerReference: true },
        });
        if (reRead?.providerReference) {
          ref = reRead.providerReference;
          break;
        }
      }

      if (ref) {
        providerReference = ref;
        logger.info("saas.payment_creation_reuse_after_wait", {
          cycleId: cycle.id, invoiceId: invoice.id, providerReference, waitedMs: waited,
        });
      } else {
        // The winner didn't persist the reference within 10 seconds.
        // This could be a crash or a slow provider. Return financial_pending —
        // the reconciliation worker will re-claim the cycle after 5 minutes.
        logger.warn("saas.payment_creation_timeout", {
          cycleId: cycle.id, invoiceId: invoice.id, waitedMs: waited,
        });
        return {
          success: false,
          status: "financial_pending",
          reason: "Payment operation creation in progress by another worker — cycle will be recovered if stuck",
        };
      }
    } else {
      // We won the claim — we are the ONLY worker allowed to call createPaymentIntent.
      logger.info("saas.payment_creation_claimed", {
        cycleId: cycle.id, invoiceId: invoice.id,
      });

      // Create the payment intent at the provider.
      const intent = await provider.createPaymentIntent({
        amountMinor,
        currency: plan.currency as Currency,
        description: `SaaS renewal: ${plan.displayName} (${subscription.billingCycle})`,
        idempotencyKey: renewalKey,
        metadata: { tenantId, planName: plan.name, type: "saas_renewal" },
      });
      providerReference = intent.providerReference;

      // Persist the providerReference BEFORE any other work.
      // If persistence fails, the cycle stays in PAYMENT_CREATING — the
      // reconciliation worker will re-claim it after 5 minutes and retry.
      try {
        await db.tenantInvoice.update({
          where: { id: invoice.id },
          data: { providerReference, paymentProvider: provider.id },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("saas.providerReference_persist_failed", {
          invoiceId: invoice.id, cycleId: cycle.id, providerReference, error: errorMsg,
          message: "CRITICAL: Failed to persist providerReference after claiming PAYMENT_CREATING. Cycle will be recovered by the reconciliation worker after 5 minutes.",
        });
        // Leave the cycle in PAYMENT_CREATING — the reconciliation worker
        // will re-claim it and retry. Do NOT transition to RECONCILIATION_REQUIRED
        // because that would allow another worker to immediately re-attempt
        // createPaymentIntent, which could create a second provider operation
        // if the first one actually succeeded at the provider but we didn't
        // receive the response.
        return {
          success: false,
          status: "financial_pending",
          reason: "ProviderReference persistence failed — cycle will be recovered after 5-minute timeout",
        };
      }
    }
  }

  // For the mock provider, auto-confirm
  if (provider.isMock) {
    const { mockPaymentProvider } = await import("@/lib/payments");
    mockPaymentProvider.confirmIntent(providerReference);
  }

  // Verify the payment
  const verification = await provider.verifyPayment({
    providerReference,
    idempotencyKey: renewalKey,
  });

  if (verification.status === "failed") {
    // Phase 2B.3.14 P0-3: GUARDED transitions — never overwrite a concurrently-finalized state.
    // A webhook may have arrived during verifyPayment() and finalized the invoice/cycle.
    // Each mutation is PostgreSQL-atomic with a state guard.
    const invoiceGuarded = await db.tenantInvoice.updateMany({
      where: { id: invoice.id, status: "pending" },
      data: { status: "failed", failureReason: "Renewal payment failed" },
    });
    if (invoiceGuarded.count === 0) {
      // The invoice was no longer pending — a concurrent worker advanced it.
      logger.info("saas.renewal_failed_invoice_already_advanced", { invoiceId: invoice.id, cycleId: cycle.id });
      // Do NOT overwrite the subscription or cycle — they may have been finalized.
      // Re-read and reconcile.
      const currentCycle = await db.saasRenewalCycle.findUnique({ where: { id: cycle.id }, select: { state: true } });
      if (currentCycle?.state === "COMPLETED") {
        return { success: true, status: "active" };
      }
      return { success: false, status: "financial_pending", reason: "Invoice was concurrently advanced — skipping destructive overwrite" };
    }
    // Invoice was actually transitioned to failed — now guard the subscription + cycle.
    await db.tenantSubscription.updateMany({
      where: { id: subscription.id, status: { in: ["active", "trialing", "pending_payment"] } },
      data: { status: "past_due" },
    });
    await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: { notIn: ["COMPLETED", "PAST_DUE"] } },
      data: { state: "PAST_DUE", failureReason: "Payment failed" },
    });
    return { success: false, status: "past_due", reason: "Renewal payment failed" };
  }

  if (verification.status === "pending") {
    // Phase 2B.3.14 P2-11: Guarded transition — don't overwrite a concurrently-active subscription.
    await db.tenantSubscription.updateMany({
      where: { id: subscription.id, status: { in: ["active", "trialing", "pending_payment"] } },
      data: { status: "past_due" },
    });
    // Phase 2B.3.16: Cycle stays in PAYMENT_CREATING (or transitions back to
    // PAYMENT_PENDING if it was in PAYMENT_CREATING — the payment intent exists
    // at the provider, we just don't have confirmation yet). The reconciliation
    // worker will pick it up and re-verify.
    // Phase 2B.3.17: Remove silent .catch(() => {}) — emit CRITICAL on failure.
    const pendingTransition = await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: "PAYMENT_CREATING" },
      data: { state: "PAYMENT_PENDING" },
    });
    if (pendingTransition.count === 0) {
      // Not in PAYMENT_CREATING — could be a concurrent transition. Log for visibility.
      logger.info("saas.payment_creating_to_pending_noop", {
        cycleId: cycle.id, tenantId, subscriptionId: subscription.id,
        message: "Cycle was not in PAYMENT_CREATING — may have been concurrently transitioned.",
      });
    }
    return { success: false, status: "past_due", reason: "Payment pending" };
  }

  // Payment succeeded — transition cycle to PAYMENT_CONFIRMED.
  // Phase 2B.3.16: Guarded — only transition from PAYMENT_CREATING or PAYMENT_PENDING.
  // Don't overwrite COMPLETED/RECONCILIATION_REQUIRED.
  await db.saasRenewalCycle.updateMany({
    where: { id: cycle.id, state: { in: ["PAYMENT_CREATING", "PAYMENT_PENDING"] } },
    data: { state: "PAYMENT_CONFIRMED" },
  });

  // Attempt financial finalization.
  // Phase 2B.3.14 P1-6: Thread provider paidAt through.
  // Phase 2B.3.17 P0-4: Pass paymentVerified=true — verifyPayment returned "succeeded".
  const result = await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId,
    userId: "renewal-worker",
    paidAt: verification.paidAt,
    paymentVerified: true,
  });

  if (!result.activated) {
    // Ledger failed — cycle → RECONCILIATION_REQUIRED, period NOT extended.
    // Phase 2B.3.14 P2-12: Guarded — don't overwrite COMPLETED.
    await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: { not: "COMPLETED" } },
      data: { state: "RECONCILIATION_REQUIRED", failureReason: "Ledger posting failed" },
    });
    return { success: false, status: "financial_pending", reason: "Ledger posting failed during renewal — invoice is reconciliation_required" };
  }

  // Phase 2B.3.6: Financial finalization succeeded — use the single
  // authoritative completion function to extend the period + complete the cycle.
  const completion = await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId });
  if (completion.completed) {
    logger.info("saas.subscription_renewed", { tenantId, subscriptionId: subscription.id, cycleId: cycle.id, newPeriodEnd });
    return { success: true, status: "active" };
  } else {
    // Period extension failed — mark cycle for retry.
    // Phase 2B.3.14 P2-12: Guarded (already had state guard, but use updateMany for consistency).
    await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: { not: "COMPLETED" } },
      data: { state: "RECONCILIATION_REQUIRED", failureReason: "Period extension failed" },
    });
    return { success: false, status: "financial_pending", reason: "Period extension failed after successful ledger posting" };
  }
}

/**
 * Process all due SaaS subscription renewals.
 * Called by the reconciliation cron endpoint.
 */
export async function processDueSaasRenewals(): Promise<{
  renewed: number;
  failed: number;
  skipped: number;
}> {
  const result = { renewed: 0, failed: 0, skipped: 0 };
  const now = new Date();

  // Phase 2B.3.3 P0-1: Only renew subscriptions that are active or past_due.
  // PENDING_PAYMENT subscriptions must NOT enter the renewal pipeline —
  // they haven't paid for their first period yet.
  // TRIALING is reserved for actual free trials and should not be renewed
  // by the paid renewal path.
  const due = await db.tenantSubscription.findMany({
    where: {
      currentPeriodEnd: { lt: now },
      status: { in: ["active", "past_due"] },
    },
    select: { tenantId: true },
  });

  for (const sub of due) {
    const renewal = await renewSubscription(sub.tenantId);
    if (renewal.success) {
      result.renewed++;
    } else if (renewal.status === "past_due") {
      result.failed++;
    } else {
      result.skipped++;
    }
  }

  return result;
}

/**
 * Handle a SaaS subscription payment webhook (from the payment provider).
 * Idempotent: if the invoice is already paid, returns without re-charging.
 */
/**
 * Phase 2B.3.4: Handle a SaaS payment webhook with provider identity.
 * The webhook must include the providerKey so we can find the invoice by
 * (paymentProvider, providerReference) — not just providerReference alone.
 * This prevents cross-provider collisions if two providers generate
 * the same reference.
 */
export async function handleSaasPaymentWebhook(input: {
  providerKey: string;
  providerReference: string;
  status: "succeeded" | "failed" | "pending";
  /** Phase 2B.3.14 P1-6: Provider's authoritative payment timestamp from the webhook event. */
  paidAt?: Date;
}): Promise<{ handled: boolean }> {
  const invoice = await db.tenantInvoice.findFirst({
    where: {
      paymentProvider: input.providerKey,
      providerReference: input.providerReference,
    },
    include: { subscription: true },
  });
  if (!invoice) {
    logger.warn("saas.webhook_no_match", { providerReference: input.providerReference });
    return { handled: false };
  }

  // Phase 2B.3.4: State monotonicity — a paid invoice must NOT be rolled back.
  // A "failed" webhook arriving after a "succeeded" webhook must NOT change
  // the invoice from paid → failed.
  if (invoice.status === "paid") {
    logger.info("saas.webhook_idempotent_paid", { invoiceId: invoice.id, incomingStatus: input.status });
    return { handled: true };
  }

  // Also protect reconciliation_required from being overwritten by "failed"
  // (the payment was already verified — a later failed event shouldn't undo that)
  if (invoice.status === "reconciliation_required" && input.status === "failed") {
    logger.warn("saas.webhook_failed_after_reconciliation", { invoiceId: invoice.id });
    return { handled: true };
  }

  if (input.status === "succeeded") {
    // Phase 2B.3.17 P0-4: Pass paymentVerified=true — webhook reports "succeeded".
    const result = await activateSubscriptionAndPostLedger({
      subscriptionId: invoice.subscriptionId,
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      userId: "webhook",
      paidAt: input.paidAt,
      paymentVerified: true,
    });

    // Phase 2B.3.10: If financial finalization succeeded, complete the renewal cycle.
    // If completion FAILS, mark the cycle RECONCILIATION_REQUIRED so the worker
    // can retry the domain completion (not the payment or ledger).
    if (result.activated) {
      const completion = await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId: invoice.tenantId });
      if (!completion.completed) {
        // Financial work is done (invoice paid + ledger posted) but domain
        // completion failed. Mark the cycle for recovery.
        const cycle = await db.saasRenewalCycle.findFirst({ where: { invoiceId: invoice.id } });
        if (cycle && cycle.state !== "COMPLETED") {
          await db.saasRenewalCycle.updateMany({
            where: { id: cycle.id, state: { not: "COMPLETED" } },
            data: { state: "RECONCILIATION_REQUIRED", failureReason: "Domain completion failed after webhook" },
          }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
        }
        logger.error("saas.webhook_completion_failed", {
          invoiceId: invoice.id,
          message: "CRITICAL: Financial finalization succeeded but renewal cycle completion failed. Cycle marked RECONCILIATION_REQUIRED.",
        });
      }
    }
    return { handled: true };
  }

  if (input.status === "failed") {
    // Status-guarded: only pending → failed (don't overwrite paid/reconciliation_required)
    // Phase 2B.3.14 P0: This was already guarded for the invoice, but the subscription
    // update is now also guarded to prevent overwriting an active subscription.
    await db.tenantInvoice.updateMany({
      where: { id: invoice.id, status: "pending" },
      data: { status: "failed", failureReason: "Webhook reported payment failed" },
    });
    await db.tenantSubscription.updateMany({
      where: { id: invoice.subscriptionId, status: { in: ["pending_payment", "active", "trialing"] } },
      data: { status: "past_due" },
    });
    return { handled: true };
  }

  return { handled: false };
}

/**
 * List a tenant's invoices (receipt history).
 */
export async function listTenantInvoices(tenantId: string, limit = 20) {
  return db.tenantInvoice.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Phase 2B.3.1 — SaaS Financial Reconciliation Worker
// ---------------------------------------------------------------------------

/**
 * Process SaaS invoices stuck in reconciliation_required.
 *
 * For each stuck invoice:
 *   1. Retry ledgerSaasSubscriptionPayment (idempotent — replays if key exists)
 *   2. If ledger succeeds → mark invoice as paid + activate subscription
 *   3. If ledger still fails → leave as reconciliation_required for next run
 *
 * Also scans for stale "pending" invoices (older than 5 minutes) whose payment
 * was confirmed by the provider but never financially finalized.
 *
 * Idempotent: ledger replays via idempotencyKey, status-guarded transitions.
 */
export async function processDueSaasFinancialReconciliation(): Promise<{
  retried: number;
  repaired: number;
  stillFailing: number;
}> {
  const result = { retried: 0, repaired: 0, stillFailing: 0 };

  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const due = await db.tenantInvoice.findMany({
    where: {
      OR: [
        { status: "reconciliation_required" },
        { status: "pending", createdAt: { lt: staleCutoff }, providerReference: { not: null } },
      ],
    },
    include: { subscription: true },
  });

  for (const invoice of due) {
    if (!invoice.subscription) continue;
    result.retried++;

    try {
      // Phase 2B.3.2 P0-2: For stale "pending" invoices, we MUST verify the
      // payment with the provider before posting any ledger entry.
      // A providerReference only proves a payment intent exists — it does NOT
      // prove the payment succeeded. Only reconciliation_required invoices
      // have already been verified (the payment was confirmed by the caller
      // before the ledger attempt failed).
      let stalePendingPaidAt: Date | undefined;
      if (invoice.status === "pending") {
        if (!invoice.providerReference || !invoice.paymentProvider) {
          // No provider reference — can't verify, skip
          logger.warn("saas.reconciliation_no_provider_ref", { invoiceId: invoice.id });
          continue;
        }

        // Phase 2B.3.3 P0-2: Resolve provider from the invoice's paymentProvider field
        const provider = getPaymentProviderByKey(invoice.paymentProvider || "mock");
        const verification = await provider.verifyPayment({
          providerReference: invoice.providerReference,
          idempotencyKey: invoice.idempotencyKey,
        });

        if (verification.status === "failed") {
          // Phase 2B.3.14 P0-2: GUARDED transition — never overwrite a concurrently-paid invoice.
          // The invoice was selected as "pending" but may have been finalized by a webhook
          // while verifyPayment() was in flight. The mutation must be PostgreSQL-atomic.
          const guarded = await db.tenantInvoice.updateMany({
            where: { id: invoice.id, status: "pending" },
            data: { status: "failed", failureReason: "Payment verification failed during reconciliation" },
          });
          if (guarded.count === 0) {
            // The invoice was no longer pending — a concurrent worker advanced it.
            logger.info("saas.reconciliation_failed_invoice_already_advanced", {
              invoiceId: invoice.id,
            });
            // Do NOT overwrite the subscription — it may have been activated.
            continue;
          }
          // Invoice was actually transitioned to failed — guard the subscription too.
          await db.tenantSubscription.updateMany({
            where: { id: invoice.subscriptionId, status: { in: ["pending_payment", "active", "trialing"] } },
            data: { status: "past_due" },
          });
          logger.info("saas.reconciliation_payment_failed", { invoiceId: invoice.id });
          continue;
        }

        if (verification.status === "pending") {
          // Payment still pending — do NOT post revenue, leave as pending
          logger.info("saas.reconciliation_payment_pending", { invoiceId: invoice.id });
          continue;
        }

        // verification.status === "succeeded" — proceed to financial finalization.
        // Phase 2B.3.14 P1-6: Capture the provider's authoritative paidAt.
        // This is the critical fix: the stale-pending path now uses the provider's
        // payment timestamp, not the reconciliation execution time.
        stalePendingPaidAt = verification.paidAt;
      }

      // For reconciliation_required invoices, the payment was already verified
      // by the original caller. The ledger just needs to be retried.
      // For stale-pending invoices that just verified as succeeded, use the provider paidAt.
      // Phase 2B.3.17 P0-4: Pass paymentVerified=true when we just verified the
      // payment (stalePendingPaidAt is set). For reconciliation_required invoices,
      // paymentVerified is false — but the invoice status is "reconciliation_required"
      // (not "pending"), so the guard inside activateSubscriptionAndPostLedger allows it.
      const activated = await activateSubscriptionAndPostLedger({
        subscriptionId: invoice.subscriptionId,
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        userId: "reconciliation-worker",
        paidAt: stalePendingPaidAt,
        paymentVerified: !!stalePendingPaidAt,
      });
      if (activated.activated) {
        result.repaired++;
        logger.info("saas.invoice_reconciled", { invoiceId: invoice.id, subscriptionId: invoice.subscriptionId });

        // Phase 2B.3.10: Complete the renewal cycle. If completion fails,
        // mark the cycle RECONCILIATION_REQUIRED for the cycle-driven scan.
        const completion = await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId: invoice.tenantId });
        if (!completion.completed) {
          const cycle = await db.saasRenewalCycle.findFirst({ where: { invoiceId: invoice.id } });
          if (cycle && cycle.state !== "COMPLETED") {
            await db.saasRenewalCycle.updateMany({
              where: { id: cycle.id, state: { not: "COMPLETED" } },
              data: { state: "RECONCILIATION_REQUIRED", failureReason: "Domain completion failed during reconciliation" },
            }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
          }
          logger.error("saas.reconciliation_completion_failed", { invoiceId: invoice.id });
        }
      } else {
        result.stillFailing++;
      }
    } catch (err) {
      result.stillFailing++;
      logger.error("saas.reconciliation_still_failing", {
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 2B.3.16: Stuck PAYMENT_CREATING scan.
  // Find cycles stuck in PAYMENT_CREATING for > 5 minutes. These represent
  // crashed payment-operation acquisitions — the worker claimed the right to
  // call createPaymentIntent but never completed (crash, timeout, or DB failure).
  //
  // Recovery: re-claim the cycle by transitioning it back to PAYMENT_PENDING,
  // but ONLY if the invoice doesn't already have a providerReference. If it
  // does have a reference, the payment operation was created at the provider —
  // we must NOT create another one. Instead, transition to PAYMENT_CONFIRMED
  // and let the normal verification path proceed.
  //
  // The 5-minute timeout is chosen to be longer than any reasonable provider
  // API call (Stripe/Paystack/Flutterwave typically respond in < 30 seconds).
  // This prevents premature re-claims while ensuring crashed workers don't
  // permanently block renewal.
  const stuckPaymentCreatingCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const stuckCreatingCycles = await db.saasRenewalCycle.findMany({
    where: {
      state: "PAYMENT_CREATING",
      updatedAt: { lt: stuckPaymentCreatingCutoff },
    },
    select: { id: true, invoiceId: true, tenantId: true, subscriptionId: true },
  });

  for (const cycle of stuckCreatingCycles) {
    if (!cycle.invoiceId) {
      // No invoice — reset to PENDING so renewSubscription can retry from scratch.
      // Phase 2B.3.17: Remove silent .catch(() => {}) — emit CRITICAL on failure.
      const noInvResult = await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, state: "PAYMENT_CREATING" },
        data: { state: "PENDING", failureReason: "Payment creation timed out — no invoice linked" },
      });
      if (noInvResult.count === 0) {
        logger.error("saas.stuck_creating_no_invoice_reset_failed", {
          cycleId: cycle.id, tenantId: cycle.tenantId, subscriptionId: cycle.subscriptionId,
          previousState: "PAYMENT_CREATING", intendedState: "PENDING",
          message: "CRITICAL: Failed to reset stuck PAYMENT_CREATING cycle with no invoice.",
        });
      }
      continue;
    }

    // Check if the providerReference was persisted despite the crash.
    const inv = await db.tenantInvoice.findUnique({
      where: { id: cycle.invoiceId },
      select: { providerReference: true, status: true },
    });

    if (inv?.providerReference) {
      // The payment operation WAS created at the provider — the worker crashed
      // after persisting the reference but before transitioning the cycle.
      // Transition to PAYMENT_PENDING so the normal verification path can
      // proceed. We must NOT create another payment operation.
      logger.info("saas.stuck_creating_has_reference", {
        cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: inv.providerReference,
      });
      // Phase 2B.3.17: Remove silent .catch(() => {}) — emit CRITICAL on failure.
      const hasRefResult = await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, state: "PAYMENT_CREATING" },
        data: { state: "PAYMENT_PENDING", failureReason: null },
      });
      if (hasRefResult.count === 0) {
        logger.error("saas.stuck_creating_has_reference_reset_failed", {
          cycleId: cycle.id, tenantId: cycle.tenantId, subscriptionId: cycle.subscriptionId,
          invoiceId: cycle.invoiceId, providerReference: inv.providerReference,
          previousState: "PAYMENT_CREATING", intendedState: "PAYMENT_PENDING",
          message: "CRITICAL: Failed to transition stuck PAYMENT_CREATING cycle with reference to PAYMENT_PENDING.",
        });
      }
      result.retried++;
    } else {
      // The payment operation was NOT created (or we can't prove it was).
      // The ambiguous case: the worker may have called createPaymentIntent at
      // the provider but crashed before receiving the response or persisting
      // the reference. In this case, we CANNOT safely call createPaymentIntent
      // again without risking a second payment operation.
      //
      // Phase 2B.3.17 P0-1/P0-3: Use AMBIGUOUS_PAYMENT (NOT RECONCILIATION_REQUIRED).
      // This state is NOT eligible for activateSubscriptionAndPostLedger() —
      // it must NOT post revenue. The only way out is a provider-resolution
      // step (resolveAmbiguousPayment) that either recovers the reference or
      // proves the operation doesn't exist.
      logger.error("saas.stuck_creating_ambiguous", {
        cycleId: cycle.id, invoiceId: cycle.invoiceId, tenantId: cycle.tenantId,
        subscriptionId: cycle.subscriptionId,
        message: "CRITICAL: Payment creation timed out with no providerReference. Cannot safely retry — may require manual provider audit to determine if a payment operation was created.",
      });
      const ambResult = await db.saasRenewalCycle.updateMany({
        where: { id: cycle.id, state: "PAYMENT_CREATING" },
        data: {
          state: "AMBIGUOUS_PAYMENT",
          failureReason: "Payment creation timed out with no providerReference — ambiguous state, requires provider audit or manual resolution",
        },
      });
      if (ambResult.count === 0) {
        logger.error("saas.ambiguous_state_persist_failed", {
          cycleId: cycle.id, tenantId: cycle.tenantId, subscriptionId: cycle.subscriptionId,
          previousState: "PAYMENT_CREATING",
          intendedState: "AMBIGUOUS_PAYMENT",
          message: "CRITICAL: Failed to persist AMBIGUOUS_PAYMENT state. The cycle may remain stuck in PAYMENT_CREATING.",
        });
      }
      result.stillFailing++;
    }
  }

  // Phase 2B.3.10: Cycle-driven scan — find cycles in RECONCILIATION_REQUIRED
  // even when their invoice is already PAID. These represent paid renewals
  // where the domain completion (period extension) failed.
  // The worker retries ONLY the domain completion — no payment, no ledger.
  const stuckCycles = await db.saasRenewalCycle.findMany({
    where: { state: "RECONCILIATION_REQUIRED" },
    select: { id: true, invoiceId: true, tenantId: true, subscriptionId: true },
  });

  for (const cycle of stuckCycles) {
    if (!cycle.invoiceId) {
      logger.warn("saas.reconciliation_cycle_no_invoice", { cycleId: cycle.id });
      continue;
    }

    // Verify the invoice is paid + ledger exists before attempting completion
    const inv = await db.tenantInvoice.findUnique({
      where: { id: cycle.invoiceId },
      select: { status: true, ledgerTransactionId: true },
    });

    if (!inv || inv.status !== "paid" || !inv.ledgerTransactionId) {
      // Invoice isn't financially ready — leave for the invoice-driven scan
      continue;
    }

    // Invoice is paid + ledger exists — retry ONLY the domain completion
    result.retried++;
    try {
      const completion = await completeSaasRenewalCycle({
        invoiceId: cycle.invoiceId,
        tenantId: cycle.tenantId,
      });
      if (completion.completed) {
        result.repaired++;
        logger.info("saas.cycle_reconciled", { cycleId: cycle.id, invoiceId: cycle.invoiceId });
      } else {
        result.stillFailing++;
      }
    } catch (err) {
      result.stillFailing++;
      logger.error("saas.cycle_reconciliation_failed", {
        cycleId: cycle.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 2B.3.11 P0-1: Initial subscription recovery scan.
  // Find subscriptions in reconciliation_required with a paid invoice + ledger.
  // These represent initial activations where financial finalization succeeded
  // but domain activation failed. Retry ONLY the domain activation.
  const stuckSubs = await db.tenantSubscription.findMany({
    where: { status: "reconciliation_required" },
    select: { id: true, tenantId: true, saaasPlanId: true, billingCycle: true },
  });

  for (const sub of stuckSubs) {
    const paidInvoice = await db.tenantInvoice.findFirst({
      where: { subscriptionId: sub.id, status: "paid", ledgerTransactionId: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    if (!paidInvoice || !paidInvoice.ledgerTransactionId) {
      continue;
    }

    const ledgerExists = await db.ledgerTransaction.findUnique({
      where: { id: paidInvoice.ledgerTransactionId },
      select: { id: true },
    });
    if (!ledgerExists) {
      logger.error("saas.initial_recovery_ledger_missing", { subscriptionId: sub.id, invoiceId: paidInvoice.id });
      continue;
    }

    // Retry ONLY the domain activation (no payment, no ledger)
    result.retried++;
    try {
      const activated = await activateSubscriptionAndPostLedger({
        subscriptionId: sub.id,
        invoiceId: paidInvoice.id,
        tenantId: sub.tenantId,
        userId: "reconciliation-worker",
      });
      if (activated.activated) {
        result.repaired++;
        logger.info("saas.initial_activation_reconciled", { subscriptionId: sub.id, invoiceId: paidInvoice.id });
      } else {
        result.stillFailing++;
      }
    } catch (err) {
      result.stillFailing++;
      logger.error("saas.initial_activation_recovery_failed", {
        subscriptionId: sub.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Phase 2B.3.17 P0-2 / Phase 2B.3.18: Resolve an AMBIGUOUS_PAYMENT cycle.
 *
 * This is the ONLY safe way out of the AMBIGUOUS_PAYMENT state. It requires
 * a providerReference that was recovered via a manual provider audit.
 *
 * Phase 2B.3.18 P0: The function now verifies that the recovered provider
 * payment EXACTLY matches the invoice — not just that "a payment succeeded".
 * It checks:
 *   - provider identity matches invoice.paymentProvider
 *   - providerReference belongs to a real provider payment
 *   - amount == invoice.amountMinor
 *   - currency == invoice.currency
 *   - payment status == succeeded
 *
 * If ANY of these checks fail, resolution fails closed and the cycle remains
 * AMBIGUOUS_PAYMENT. This prevents an operator from accidentally associating
 * the wrong successful payment with an invoice.
 *
 * Phase 2B.3.18 P1: paidAt persistence failure now BLOCKS financial
 * finalization. If the provider returns a paidAt but it cannot be persisted,
 * the cycle is NOT finalized — it remains in a retryable recovery state.
 *
 * This function is intentionally NOT called automatically by the reconciliation
 * worker. It requires a human to recover the providerReference from the
 * provider's dashboard/API. The system does NOT guess.
 */
export async function resolveAmbiguousPayment(input: {
  cycleId: string;
  tenantId: string;
  /** The providerReference recovered from a manual provider audit. */
  providerReference: string;
}): Promise<{ resolved: boolean; status: string; reason?: string }> {
  const cycle = await db.saasRenewalCycle.findUnique({
    where: { id: input.cycleId },
    select: { id: true, state: true, invoiceId: true, tenantId: true, subscriptionId: true },
  });

  if (!cycle) {
    return { resolved: false, status: "error", reason: "Cycle not found" };
  }

  if (cycle.tenantId !== input.tenantId) {
    return { resolved: false, status: "error", reason: "Cross-tenant access denied" };
  }

  if (cycle.state !== "AMBIGUOUS_PAYMENT") {
    return { resolved: false, status: "error", reason: `Cycle is not in AMBIGUOUS_PAYMENT state (current: ${cycle.state})` };
  }

  if (!cycle.invoiceId) {
    return { resolved: false, status: "error", reason: "No invoice linked to cycle" };
  }

  // Load the FULL invoice — we need amountMinor and currency for correlation.
  const invoice = await db.tenantInvoice.findUnique({
    where: { id: cycle.invoiceId },
    select: { paymentProvider: true, idempotencyKey: true, amountMinor: true, currency: true },
  });
  if (!invoice) {
    return { resolved: false, status: "error", reason: "Invoice not found" };
  }

  const provider = getPaymentProviderByKey(invoice.paymentProvider || "mock");

  // Verify the payment with the provider using the recovered reference.
  const verification = await provider.verifyPayment({
    providerReference: input.providerReference,
    idempotencyKey: invoice.idempotencyKey,
  });

  if (verification.status === "pending") {
    // Provider verification returned pending — leave in AMBIGUOUS_PAYMENT.
    logger.info("saas.ambiguous_resolved_pending", {
      cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: input.providerReference,
    });
    return { resolved: false, status: "pending", reason: "Provider verification returned pending — retry later" };
  }

  if (verification.status === "failed") {
    // The provider confirms no payment exists (or it failed).
    // Safe to retry — transition to PENDING so renewSubscription can create a new payment.
    logger.info("saas.ambiguous_resolved_failed", {
      cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: input.providerReference,
    });
    await db.saasRenewalCycle.updateMany({
      where: { id: cycle.id, state: "AMBIGUOUS_PAYMENT" },
      data: { state: "PENDING", failureReason: "Provider audit confirmed no payment exists — safe to retry" },
    });
    return { resolved: true, status: "resolved_failed" };
  }

  // verification.status === "succeeded"
  // Phase 2B.3.18 P0: EXACT INVOICE CORRELATION — verify that this provider
  // payment actually belongs to THIS invoice, not a different one.
  // The provider must return amount and currency; we compare them to the invoice.
  if (verification.amountMinor === undefined || verification.currency === undefined) {
    // The provider didn't return amount/currency — we CANNOT verify correlation.
    // Fail closed: remain AMBIGUOUS_PAYMENT. Do NOT proceed to finalization.
    logger.error("saas.ambiguous_resolution_missing_amount_currency", {
      cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: input.providerReference,
      message: "CRITICAL: Provider verification succeeded but did not return amount/currency. Cannot verify invoice correlation. Resolution refused — cycle remains AMBIGUOUS_PAYMENT.",
    });
    return {
      resolved: false,
      status: "error",
      reason: "Provider verification did not return amount/currency — cannot verify invoice correlation",
    };
  }

  // Verify amount matches.
  if (verification.amountMinor !== invoice.amountMinor) {
    logger.error("saas.ambiguous_resolution_amount_mismatch", {
      cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: input.providerReference,
      expectedAmount: invoice.amountMinor, providerAmount: verification.amountMinor,
      message: "CRITICAL: Recovered payment amount does not match invoice amount. This may be the wrong payment. Resolution refused — cycle remains AMBIGUOUS_PAYMENT.",
    });
    return {
      resolved: false,
      status: "error",
      reason: `Amount mismatch: invoice=${invoice.amountMinor}, provider=${verification.amountMinor}`,
    };
  }

  // Verify currency matches (case-insensitive — providers may return lowercase).
  if (verification.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
    logger.error("saas.ambiguous_resolution_currency_mismatch", {
      cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: input.providerReference,
      expectedCurrency: invoice.currency, providerCurrency: verification.currency,
      message: "CRITICAL: Recovered payment currency does not match invoice currency. Resolution refused — cycle remains AMBIGUOUS_PAYMENT.",
    });
    return {
      resolved: false,
      status: "error",
      reason: `Currency mismatch: invoice=${invoice.currency}, provider=${verification.currency}`,
    };
  }

  // Phase 2B.3.18 P0: All correlation checks passed. The recovered payment
  // is verified to belong to THIS invoice. Proceed to finalization.
  logger.info("saas.ambiguous_resolved_succeeded", {
    cycleId: cycle.id, invoiceId: cycle.invoiceId, providerReference: input.providerReference,
    amountMinor: verification.amountMinor, currency: verification.currency,
  });

  // Phase 2B.3.18 P1: paidAt persistence — BLOCKS finalization on failure.
  // Do this BEFORE the atomic claim, so if it fails, the cycle remains
  // AMBIGUOUS_PAYMENT (unchanged) and the operator can retry.
  if (verification.paidAt) {
    try {
      const paidAtResult = await db.tenantInvoice.updateMany({
        where: { id: cycle.invoiceId, paidAt: null },
        data: { paidAt: verification.paidAt },
      });
      logger.info("saas.ambiguous_paidAt_persisted", {
        invoiceId: cycle.invoiceId, paidAt: verification.paidAt, updated: paidAtResult.count,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("saas.ambiguous_paidAt_persist_failed_blocking", {
        cycleId: cycle.id, tenantId: cycle.tenantId, subscriptionId: cycle.subscriptionId,
        invoiceId: cycle.invoiceId, providerReference: input.providerReference,
        paidAt: verification.paidAt, error: errorMsg,
        message: "CRITICAL: paidAt persistence failed. Financial finalization BLOCKED. Cycle remains AMBIGUOUS_PAYMENT for retry.",
      });
      return {
        resolved: false,
        status: "error",
        reason: `paidAt persistence failed: ${errorMsg} — cycle remains AMBIGUOUS_PAYMENT`,
      };
    }
  }

  // Phase 2B.3.18 P1: ATOMIC CLAIM — transition AMBIGUOUS_PAYMENT → PAYMENT_PENDING.
  // This prevents concurrent resolveAmbiguousPayment calls from both proceeding
  // to finalization. Only the winner (count=1) continues. The loser gets count=0
  // and returns without posting a duplicate ledger.
  const claim = await db.saasRenewalCycle.updateMany({
    where: { id: cycle.id, state: "AMBIGUOUS_PAYMENT" },
    data: { state: "PAYMENT_PENDING", failureReason: null },
  });
  if (claim.count === 0) {
    logger.info("saas.ambiguous_resolution_claim_lost", {
      cycleId: cycle.id, tenantId: cycle.tenantId,
    });
    return {
      resolved: false,
      status: "error",
      reason: "Cycle was concurrently resolved by another worker",
    };
  }

  // Persist the providerReference (only the winner reaches this point).
  await db.tenantInvoice.update({
    where: { id: cycle.invoiceId },
    data: { providerReference: input.providerReference },
  });

  // Phase 2B.3.17 P0-2: We already verified the payment — proceed directly
  // to financial finalization. Don't wait for the reconciliation worker.
  const activated = await activateSubscriptionAndPostLedger({
    subscriptionId: cycle.subscriptionId,
    invoiceId: cycle.invoiceId,
    tenantId: cycle.tenantId,
    userId: "ambiguous-resolver",
    paidAt: verification.paidAt,
    paymentVerified: true,
  });
  if (activated.activated) {
    // Complete the renewal cycle.
    const completion = await completeSaasRenewalCycle({ invoiceId: cycle.invoiceId, tenantId: cycle.tenantId });
    if (completion.completed) {
      return { resolved: true, status: "resolved_succeeded" };
    }
  }
  // If finalization didn't complete, the cycle is in PAYMENT_PENDING — the
  // reconciliation worker will pick it up on the next run.
  return { resolved: true, status: "resolved_succeeded_pending_finalization" };
}
