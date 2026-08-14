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
  if (plan.monthlyPriceMinor === 0) {
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
    await db.tenantInvoice.update({
      where: { id: invoice.id },
      data: { status: "failed", failureReason: "Payment verification failed" },
    });
    await db.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: "past_due" },
    });
    return { status: "past_due" };
  }

  if (verification.status === "pending") {
    return { status: "pending_payment" };
  }

  // Payment succeeded — attempt financial finalization + activation
  const result = await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId: input.tenantId,
    userId: input.userId,
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
}): Promise<{ activated: boolean }> {
  await ensureChartOfAccounts();

  // Get the invoice
  const invoice = await db.tenantInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) {
    throw new AppError("not_found", "Invoice not found", 404, "Invoice not found during activation.");
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

  // Step 2: Ledger succeeded — mark invoice as paid + link the ledger transaction
  const updated = await db.tenantInvoice.updateMany({
    where: { id: input.invoiceId, status: { in: ["pending", "reconciliation_required"] } },
    data: { status: "paid", paidAt: new Date(), ledgerTransactionId: ledgerTxnId, failureReason: null },
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
 * If the transaction fails, marks the subscription reconciliation_required
 * so the worker can retry. The financial state (invoice paid + ledger)
 * remains intact — only the domain activation is retried.
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
    const result = await db.$transaction(async (tx) => {
      // 1. Lock the invoice
      const lockedInvoice: Array<{ id: string; status: string; ledgerTransactionId: string | null }> = await tx.$queryRaw`
        SELECT id, status, "ledgerTransactionId"
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

      // 3. Verify prerequisites
      if (inv.status !== "paid" || !inv.ledgerTransactionId) {
        return { activated: false, reason: `Invoice not ready (status: ${inv.status})` };
      }

      // 4. Only activate if subscription is pending_payment or reconciliation_required
      if (sub.status !== "pending_payment" && sub.status !== "reconciliation_required") {
        // Already active — idempotent success
        return { activated: true, reason: "already_active" };
      }

      // 5. Calculate billing period
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      if (input.billingCycle === "yearly") {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      // 6. Update invoice period
      await tx.tenantInvoice.update({
        where: { id: input.invoiceId },
        data: { periodStart, periodEnd },
      });

      // 7. Activate the subscription
      await tx.tenantSubscription.update({
        where: { id: input.subscriptionId },
        data: { status: "active", currentPeriodEnd: periodEnd },
      });

      return { activated: true, reason: "activated", periodEnd };
    }, { timeout: 30000, maxWait: 15000 });

    if (result.activated) {
      await audit({
        tenantId: input.tenantId,
        userId: (input.userId === "renewal-worker" || input.userId === "webhook" || input.userId === "reconciliation-worker") ? undefined : input.userId,
        action: "saas.subscription_activated",
        entity: "tenant_subscription",
        entityId: input.subscriptionId,
        detail: { invoiceId: input.invoiceId, ledgerTxnId: input.ledgerTxnId, amount: input.amountMinor, source: input.source },
      });
      logger.info("saas.subscription_activated", {
        tenantId: input.tenantId, subscriptionId: input.subscriptionId,
        ledgerTxnId: input.ledgerTxnId, invoiceId: input.invoiceId, source: input.source,
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

  await db.tenantSubscription.update({
    where: { id: subscription.id },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: input.reason ?? null,
    },
  });

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

  // Don't renew if the current period hasn't ended yet
  if (subscription.currentPeriodEnd > new Date()) {
    return { success: false, status: subscription.status, reason: "Current period has not ended" };
  }

  const plan = subscription.saaasPlan;
  const amountMinor = subscription.billingCycle === "yearly" ? plan.monthlyPriceMinor * 12 : plan.monthlyPriceMinor;

  // Phase 2B.3.5: Derive the durable cycle identity from immutable periodStart.
  // The cycleKey is subscriptionId + immutable periodStart (the expired period's end).
  // This is the SAME key regardless of how many workers run concurrently.
  const newPeriodStart = subscription.currentPeriodEnd;
  const newPeriodEnd = new Date(newPeriodStart);
  if (subscription.billingCycle === "yearly") {
    newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
  } else {
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
  }

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

  // If the cycle is RECONCILIATION_REQUIRED, attempt to finalize the existing invoice.
  if (cycle.state === "RECONCILIATION_REQUIRED" || cycle.state === "FINANCIAL_POSTED") {
    if (!cycle.invoiceId) {
      return { success: false, status: "error", reason: "Cycle in financial state but no invoice" };
    }
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
      await db.saasRenewalCycle.update({
        where: { id: cycle.id },
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

  // Link the invoice to the cycle + transition to PAYMENT_PENDING
  await db.saasRenewalCycle.update({
    where: { id: cycle.id },
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
    await db.saasRenewalCycle.update({ where: { id: cycle.id }, data: { state: "FINANCIAL_POSTED" } });
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
      await db.saasRenewalCycle.update({ where: { id: cycle.id }, data: { state: "RECONCILIATION_REQUIRED" } });
      return { success: false, status: "financial_pending", reason: "Ledger posting still failing during renewal retry" };
    }
  }

  // Phase 2B.3.3: Use the subscription's stored payment provider
  const provider = getPaymentProviderByKey(subscription.paymentProvider || "mock");
  const intent = await provider.createPaymentIntent({
    amountMinor,
    currency: plan.currency as Currency,
    description: `SaaS renewal: ${plan.displayName} (${subscription.billingCycle})`,
    idempotencyKey: renewalKey,
    metadata: { tenantId, planName: plan.name, type: "saas_renewal" },
  });

  await db.tenantInvoice.update({
    where: { id: invoice.id },
    data: { providerReference: intent.providerReference, paymentProvider: provider.id },
  }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });

  // For the mock provider, auto-confirm
  if (provider.isMock) {
    const { mockPaymentProvider } = await import("@/lib/payments");
    mockPaymentProvider.confirmIntent(intent.providerReference);
  }

  // Verify the payment
  const verification = await provider.verifyPayment({
    providerReference: intent.providerReference,
    idempotencyKey: renewalKey,
  });

  if (verification.status === "failed") {
    await db.tenantInvoice.update({
      where: { id: invoice.id },
      data: { status: "failed", failureReason: "Renewal payment failed" },
    });
    await db.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: "past_due" },
    });
    await db.saasRenewalCycle.update({
      where: { id: cycle.id },
      data: { state: "PAST_DUE", failureReason: "Payment failed" },
    });
    return { success: false, status: "past_due", reason: "Renewal payment failed" };
  }

  if (verification.status === "pending") {
    await db.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: "past_due" },
    });
    // Cycle stays in PAYMENT_PENDING
    return { success: false, status: "past_due", reason: "Payment pending" };
  }

  // Payment succeeded — transition cycle to PAYMENT_CONFIRMED
  await db.saasRenewalCycle.update({
    where: { id: cycle.id },
    data: { state: "PAYMENT_CONFIRMED" },
  });

  // Attempt financial finalization
  const result = await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId,
    userId: "renewal-worker",
  });

  if (!result.activated) {
    // Ledger failed — cycle → RECONCILIATION_REQUIRED, period NOT extended
    await db.saasRenewalCycle.update({
      where: { id: cycle.id },
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
    // Period extension failed — mark cycle for retry
    await db.saasRenewalCycle.update({
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
    const result = await activateSubscriptionAndPostLedger({
      subscriptionId: invoice.subscriptionId,
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      userId: "webhook",
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
          // Payment failed — mark the invoice as failed, do NOT post revenue
          await db.tenantInvoice.update({
            where: { id: invoice.id },
            data: { status: "failed", failureReason: "Payment verification failed during reconciliation" },
          });
          await db.tenantSubscription.update({
            where: { id: invoice.subscriptionId },
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

        // verification.status === "succeeded" — proceed to financial finalization
      }

      // For reconciliation_required invoices, the payment was already verified
      // by the original caller. The ledger just needs to be retried.
      const activated = await activateSubscriptionAndPostLedger({
        subscriptionId: invoice.subscriptionId,
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        userId: "reconciliation-worker",
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
