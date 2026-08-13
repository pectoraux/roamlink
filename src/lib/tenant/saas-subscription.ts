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
import { getPaymentProvider } from "@/lib/payments";
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

  // Create or update the subscription record
  const periodEnd = new Date();
  if (billingCycle === "yearly") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  const subscription = await db.tenantSubscription.upsert({
    where: { tenantId },
    create: {
      tenantId,
      saaasPlanId: plan.id,
      status: "trialing", // not fully active until payment is confirmed
      billingCycle,
      currentPeriodEnd: periodEnd,
      paymentProvider: provider.id,
      providerReference: intent.providerReference,
    },
    update: {
      saaasPlanId: plan.id,
      status: "trialing",
      billingCycle,
      currentPeriodEnd: periodEnd,
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
      periodStart: new Date(),
      periodEnd,
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

  // Server-side payment verification
  const provider = getPaymentProvider();

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
    return { status: "trialing" };
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

  // Idempotent: if already paid, return early
  if (invoice.status === "paid") {
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
    // Phase 2B.3.1: Ledger failed — mark as reconciliation_required.
    // Do NOT mark as paid. Do NOT activate the subscription.
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
        message: "CRITICAL: Ledger failed AND status update to reconciliation_required failed. The worker will recover it via the stale-status scan.",
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
    // Another concurrent call paid it — check if it's already paid
    const current = await db.tenantInvoice.findUnique({ where: { id: input.invoiceId } });
    if (current?.status === "paid") {
      logger.info("saas.invoice_concurrently_paid", { invoiceId: input.invoiceId });
      return { activated: true };
    }
    // It's in some other state — don't activate
    logger.warn("saas.invoice_unexpected_state", { invoiceId: input.invoiceId, status: current?.status });
    return { activated: false };
  }

  // Step 3: Activate the subscription (only after ledger is confirmed + invoice is paid)
  await db.tenantSubscription.update({
    where: { id: input.subscriptionId },
    data: { status: "active" },
  });

  await audit({
    tenantId: input.tenantId,
    userId: (input.userId === "renewal-worker" || input.userId === "webhook" || input.userId === "reconciliation-worker") ? undefined : input.userId,
    action: "saas.subscription_activated",
    entity: "tenant_subscription",
    entityId: input.subscriptionId,
    detail: { invoiceId: input.invoiceId, ledgerTxnId, amount: invoice.amountMinor },
  });

  logger.info("saas.subscription_activated", { tenantId: input.tenantId, subscriptionId: input.subscriptionId, ledgerTxnId, invoiceId: input.invoiceId });
  return { activated: true };
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

  // Durable renewal identity — prevents duplicate renewal charges
  const renewalKey = `renewal_${subscription.id}_${subscription.currentPeriodEnd.getTime()}`;

  // Check if this renewal was already processed
  const existingInvoice = await db.tenantInvoice.findUnique({
    where: { idempotencyKey: renewalKey },
  });
  if (existingInvoice && existingInvoice.status === "paid") {
    // Already renewed — update the subscription status
    await db.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: "active", renewalIdempotencyKey: renewalKey },
    }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
    return { success: true, status: "active" };
  }

  const plan = subscription.saaasPlan;
  const amountMinor = subscription.billingCycle === "yearly" ? plan.monthlyPriceMinor * 12 : plan.monthlyPriceMinor;

  // Calculate the new period
  const newPeriodStart = subscription.currentPeriodEnd;
  const newPeriodEnd = new Date(newPeriodStart);
  if (subscription.billingCycle === "yearly") {
    newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
  } else {
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
  }

  // Create the invoice
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

  if (invoice.status === "paid") {
    // Already paid — idempotent return
    return { success: true, status: "active" };
  }

  // Phase 2B.3.2: If the invoice is reconciliation_required, the payment was
  // already verified but the ledger failed. Don't create a new payment intent —
  // attempt to finalize the existing invoice instead.
  if (invoice.status === "reconciliation_required") {
    const result = await activateSubscriptionAndPostLedger({
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      tenantId,
      userId: "renewal-worker",
    });

    if (result.activated) {
      // Ledger succeeded — extend the period
      await db.tenantSubscription.update({
        where: { id: subscription.id },
        data: {
          status: "active",
          currentPeriodEnd: newPeriodEnd,
          renewalIdempotencyKey: renewalKey,
        },
      });
      logger.info("saas.subscription_renewed_after_reconciliation", { tenantId, subscriptionId: subscription.id, newPeriodEnd });
      return { success: true, status: "active" };
    } else {
      // Ledger still failing — don't extend the period
      return { success: false, status: "financial_pending", reason: "Ledger posting still failing during renewal retry" };
    }
  }

  // Create a payment intent with the provider
  const provider = getPaymentProvider();
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
    }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
    return { success: false, status: "past_due", reason: "Renewal payment failed" };
  }

  if (verification.status === "pending") {
    await db.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: "past_due" },
    }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
    return { success: false, status: "past_due", reason: "Payment pending" };
  }

  // Payment succeeded — attempt financial finalization
  const result = await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId,
    userId: "renewal-worker",
  });

  if (!result.activated) {
    // Phase 2B.3.2 P0-1: Ledger failed — do NOT extend the period.
    // The invoice is now reconciliation_required. The subscription stays
    // in its current state (not active for the new period). The
    // processDueSaasFinancialReconciliation worker will retry the ledger
    // posting and, if successful, the renewal will be retried on the
    // next cron tick (the period hasn't advanced, so it will re-enter
    // renewSubscription, find the existing reconciliation_required invoice,
    // and attempt to finalize it).
    return { success: false, status: "financial_pending", reason: "Ledger posting failed during renewal — invoice is reconciliation_required" };
  }

  // Phase 2B.3.2 P0-1: Only extend the period AFTER financial finalization succeeds.
  await db.tenantSubscription.update({
    where: { id: subscription.id },
    data: {
      status: "active",
      currentPeriodEnd: newPeriodEnd,
      renewalIdempotencyKey: renewalKey,
    },
  });

  logger.info("saas.subscription_renewed", { tenantId, subscriptionId: subscription.id, newPeriodEnd });

  return { success: true, status: "active" };
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

  // Find subscriptions whose period has ended and aren't cancelled
  const due = await db.tenantSubscription.findMany({
    where: {
      currentPeriodEnd: { lt: now },
      status: { in: ["active", "past_due", "trialing"] },
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
export async function handleSaasPaymentWebhook(input: {
  providerReference: string;
  status: "succeeded" | "failed" | "pending";
}): Promise<{ handled: boolean }> {
  const invoice = await db.tenantInvoice.findFirst({
    where: { providerReference: input.providerReference },
    include: { subscription: true },
  });
  if (!invoice) {
    logger.warn("saas.webhook_no_match", { providerReference: input.providerReference });
    return { handled: false };
  }

  // Idempotent: if already paid, skip
  if (invoice.status === "paid") {
    logger.info("saas.webhook_idempotent", { invoiceId: invoice.id, status: invoice.status });
    return { handled: true };
  }

  if (input.status === "succeeded") {
    await activateSubscriptionAndPostLedger({
      subscriptionId: invoice.subscriptionId,
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      userId: "webhook",
    });
    return { handled: true };
  }

  if (input.status === "failed") {
    await db.tenantInvoice.update({
      where: { id: invoice.id },
      data: { status: "failed", failureReason: "Webhook reported payment failed" },
    }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
    await db.tenantSubscription.update({
      where: { id: invoice.subscriptionId },
      data: { status: "past_due" },
    }).catch((err) => { logger.error("saas.state_update_failed", { error: err instanceof Error ? err.message : String(err) }); });
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

        const provider = getPaymentProvider();
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

  return result;
}
