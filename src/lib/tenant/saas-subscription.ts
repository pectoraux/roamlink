/**
 * SaaS Subscription service — real payment lifecycle for tenant billing.
 *
 * Phase 2B.3: Implements the full SaaS monetization loop:
 *   1. createSubscriptionIntent (tenant chooses a plan, creates payment intent)
 *   2. confirmSubscriptionPayment (server-side verifies payment, activates subscription)
 *   3. renewSubscription (creates invoice + charges for next period)
 *   4. cancelSubscription (ends at period end, no more renewals)
 *   5. processDueSaasRenewals (cron: renews subscriptions whose period has ended)
 *
 * All financial events post to the canonical double-entry ledger via
 * ledgerSaasSubscriptionPayment. SaaS revenue is separated from connectivity
 * sales revenue and platform fee revenue.
 *
 * Idempotency: every renewal uses a durable idempotencyKey derived from the
 * subscription ID + period end. Duplicate webhook deliveries or cron retries
 * cannot double-charge.
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
    }).catch(() => {});
    return { status: "past_due" };
  }

  if (verification.status === "pending") {
    return { status: "trialing" };
  }

  // Payment succeeded — activate the subscription + post the ledger
  await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId: input.tenantId,
    userId: input.userId,
  });

  return { status: "active" };
}

/**
 * Activate the subscription and post the SaaS payment to the ledger.
 * Idempotent: status-guarded transitions.
 */
async function activateSubscriptionAndPostLedger(input: {
  subscriptionId: string;
  invoiceId: string;
  tenantId: string;
  userId: string;
}): Promise<void> {
  await ensureChartOfAccounts();

  // Mark the invoice as paid
  const updatedInvoice = await db.tenantInvoice.updateMany({
    where: { id: input.invoiceId, status: "pending" },
    data: { status: "paid", paidAt: new Date() },
  });

  if (updatedInvoice.count === 0) {
    // Already paid — idempotent return
    logger.info("saas.invoice_already_paid", { invoiceId: input.invoiceId });
    return;
  }

  // Get the invoice to know the amount
  const invoice = await db.tenantInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) return;

  // Post the ledger entry (idempotent via ledger idempotencyKey)
  let ledgerTxnId: string | null = null;
  try {
    ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId: input.tenantId,
      userId: input.userId,
      amountMinor: invoice.amountMinor,
      reason: `SaaS subscription: ${invoice.saaasPlanName} (${invoice.billingCycle})`,
      idempotencyKey: `${invoice.idempotencyKey}:ledger`,
    });
  } catch (err) {
    logger.error("saas.ledger_posting_failed", {
      invoiceId: input.invoiceId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't fail the activation — the reconciliation worker can retry the ledger
  }

  // Link the ledger transaction to the invoice
  if (ledgerTxnId) {
    await db.tenantInvoice.update({
      where: { id: input.invoiceId },
      data: { ledgerTransactionId: ledgerTxnId },
    }).catch(() => {});
  }

  // Activate the subscription
  await db.tenantSubscription.update({
    where: { id: input.subscriptionId },
    data: { status: "active" },
  }).catch(() => {});

  await audit({
    tenantId: input.tenantId,
    // System identities (renewal-worker, webhook) are not real users — pass null
    // to avoid FK constraint violation on AuditLog.userId
    userId: (input.userId === "renewal-worker" || input.userId === "webhook") ? undefined : input.userId,
    action: "saas.subscription_activated",
    entity: "tenant_subscription",
    entityId: input.subscriptionId,
    detail: { invoiceId: input.invoiceId, ledgerTxnId, amount: invoice.amountMinor },
  });

  logger.info("saas.subscription_activated", { tenantId: input.tenantId, subscriptionId: input.subscriptionId, ledgerTxnId });
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
    }).catch(() => {});
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
  }).catch(() => {});

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
    }).catch(() => {});
    return { success: false, status: "past_due", reason: "Renewal payment failed" };
  }

  if (verification.status === "pending") {
    await db.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: "past_due" },
    }).catch(() => {});
    return { success: false, status: "past_due", reason: "Payment pending" };
  }

  // Payment succeeded — post the ledger + activate
  await activateSubscriptionAndPostLedger({
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    tenantId,
    userId: "renewal-worker",
  });

  // Extend the subscription period
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
    }).catch(() => {});
    await db.tenantSubscription.update({
      where: { id: invoice.subscriptionId },
      data: { status: "past_due" },
    }).catch(() => {});
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
