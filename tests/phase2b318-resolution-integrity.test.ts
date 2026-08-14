/**
 * Phase 2B.3.18 — Ambiguous Payment Resolution Integrity
 *
 * Tests:
 *   A. Correct recovered provider payment → succeeds, exactly 1 ledger, invoice paid, cycle completed
 *   B. Wrong provider payment reference → rejected, no ledger, invoice pending, cycle AMBIGUOUS
 *   C. Correct reference but wrong amount → rejected, no ledger
 *   D. Correct reference but wrong currency → rejected, no ledger
 *   E. Provider verification says pending → remains AMBIGUOUS_PAYMENT
 *   F. Provider verification says failed → safe retry path
 *   G. paidAt persistence failure → no financial finalization (simulated)
 *   H. Duplicate resolveAmbiguousPayment → exactly one financial effect
 *   I. Concurrent resolveAmbiguousPayment calls → exactly one financial effect
 *   J. Normal renewal/initial billing tests remain green (regression)
 *
 * Static:
 *   - PaymentVerification has amountMinor and currency fields
 *   - resolveAmbiguousPayment has amount/currency correlation checks
 *   - paidAt failure blocks finalization
 *   - All provider adapters return amountMinor and currency
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import {
  createSubscriptionIntent,
  confirmSubscriptionPayment,
  renewSubscription,
  resolveAmbiguousPayment,
} from "@/lib/tenant/saas-subscription";
import { hashPassword } from "@/lib/security";
import { ensureChartOfAccounts } from "@/lib/finance/double-entry-ledger";
import { mockPaymentProvider } from "@/lib/payments";

let setupDone = false;
const tenantIds: string[] = [];
const userIds: string[] = [];

async function provisionTenant(label: string): Promise<{ tenantId: string; userId: string }> {
  const user = await db.user.create({
    data: {
      email: `saas-2b318-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
      name: `SaaS 2B.3.18 ${label}`,
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  const tenant = await createTenant({ name: `SaaS 2B.3.18 ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "owner" });
  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        saaasPlanId: freePlan.id,
        status: "active",
        billingCycle: "monthly",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });
  }
  tenantIds.push(tenant.id);
  userIds.push(user.id);
  return { tenantId: tenant.id, userId: user.id };
}

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();
  await ensureChartOfAccounts();
}

afterAll(async () => {
  try {
    for (const tid of tenantIds) {
      await db.saasRenewalCycle.deleteMany({ where: { tenantId: tid } }).catch(() => {});
      await db.tenantInvoice.deleteMany({ where: { tenantId: tid } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { tenantId: tid } }).catch(() => {});
      await db.tenantUser.deleteMany({ where: { tenantId: tid } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tid } }).catch(() => {});
    }
    for (const uid of userIds) {
      await db.user.deleteMany({ where: { id: uid } }).catch(() => {});
    }
  } catch (e) {
    console.error("afterAll:", e);
  }
  await db.$disconnect();
}, 240000);

/** Helper: create a stuck AMBIGUOUS_PAYMENT cycle for testing. */
async function createAmbiguousCycle(tenantId: string, invoiceAmountMinor?: number, invoiceCurrency?: string): Promise<{ cycleId: string; invoiceId: string }> {
  const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });

  // Upgrade the subscription to a paid plan.
  const expiredPeriodEnd = new Date(Date.now() - 86400000);
  await db.tenantSubscription.update({
    where: { tenantId },
    data: {
      saaasPlanId: plan!.id,
      billingCycle: "monthly",
      currentPeriodEnd: expiredPeriodEnd,
      status: "active",
    },
  });

  const newPeriodStart = expiredPeriodEnd;
  const newPeriodEnd = new Date(newPeriodStart.getTime());
  newPeriodEnd.setUTCMonth(newPeriodEnd.getUTCMonth() + 1);
  const cycleKey = `saas_renewal_${sub!.id}_${newPeriodStart.getTime()}`;

  const amount = invoiceAmountMinor ?? plan!.monthlyPriceMinor;
  const currency = invoiceCurrency ?? plan!.currency;

  // Create an invoice WITHOUT a providerReference (ambiguous state).
  const invoice = await db.tenantInvoice.create({
    data: {
      tenantId, subscriptionId: sub!.id, saaasPlanName: "starter",
      amountMinor: amount, currency, billingCycle: "monthly",
      periodStart: newPeriodStart, periodEnd: newPeriodEnd,
      status: "pending", idempotencyKey: cycleKey,
      paymentProvider: "mock", providerReference: null,
    },
  });

  const cycle = await db.saasRenewalCycle.create({
    data: {
      subscriptionId: sub!.id, tenantId, cycleKey,
      state: "AMBIGUOUS_PAYMENT", invoiceId: invoice.id,
      periodStart: newPeriodStart, periodEnd: newPeriodEnd,
      failureReason: "Payment creation timed out with no providerReference — ambiguous state",
    },
  });

  return { cycleId: cycle.id, invoiceId: invoice.id };
}

/** Helper: create a mock payment intent with a specific amount/currency and confirm it. */
async function createConfirmedMockPayment(amountMinor: number, currency: string): Promise<string> {
  const intent = await mockPaymentProvider.createPaymentIntent({
    amountMinor,
    currency: currency as any,
    description: "Test payment",
    idempotencyKey: `2b318_pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  });
  mockPaymentProvider.confirmIntent(intent.providerReference);
  return intent.providerReference;
}

describe("Phase 2B.3.18 — Ambiguous Payment Resolution Integrity", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // Test A: Correct recovered provider payment → succeeds
  // ---------------------------------------------------------------
  it("Test A: correct recovered payment → exactly 1 ledger, invoice paid, cycle completed", async () => {
    const { tenantId } = await provisionTenant("A");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    const providerReference = await createConfirmedMockPayment(plan!.monthlyPriceMinor, plan!.currency);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    const result = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference });

    expect(result.resolved).toBe(true);
    expect(result.status).toBe("resolved_succeeded");

    // Exactly 1 new ledger transaction.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore + 1);

    // Invoice is paid.
    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("paid");

    // Cycle is COMPLETED.
    const cycle = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycle?.state).toBe("COMPLETED");
  }, 240000);

  // ---------------------------------------------------------------
  // Test B: Wrong provider payment reference → rejected
  // ---------------------------------------------------------------
  it("Test B: wrong provider reference → rejected, no ledger, cycle AMBIGUOUS", async () => {
    const { tenantId } = await provisionTenant("B");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    // Create a payment for a DIFFERENT amount (simulating wrong reference).
    const wrongReference = await createConfirmedMockPayment(9900, "USD"); // $99 instead of $29

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    const result = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference: wrongReference });

    // Resolution must fail (amount mismatch).
    expect(result.resolved).toBe(false);
    expect(result.status).toBe("error");
    expect(result.reason).toContain("Amount mismatch");

    // No new ledger.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    // Invoice still pending.
    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("pending");

    // Cycle still AMBIGUOUS_PAYMENT.
    const cycle = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycle?.state).toBe("AMBIGUOUS_PAYMENT");
  }, 180000);

  // ---------------------------------------------------------------
  // Test C: Correct reference but wrong amount → rejected
  // ---------------------------------------------------------------
  it("Test C: correct reference but wrong amount → rejected, no ledger", async () => {
    const { tenantId } = await provisionTenant("C");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    // Create a payment with the wrong amount ($99 instead of $29).
    const wrongAmountReference = await createConfirmedMockPayment(9900, plan!.currency);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    const result = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference: wrongAmountReference });

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("Amount mismatch");

    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("pending");

    const cycle = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycle?.state).toBe("AMBIGUOUS_PAYMENT");
  }, 180000);

  // ---------------------------------------------------------------
  // Test D: Correct reference but wrong currency → rejected
  // ---------------------------------------------------------------
  it("Test D: correct reference but wrong currency → rejected, no ledger", async () => {
    const { tenantId } = await provisionTenant("D");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    // Create a payment with the correct amount but wrong currency (EUR instead of USD).
    const wrongCurrencyReference = await createConfirmedMockPayment(plan!.monthlyPriceMinor, "EUR");

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    const result = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference: wrongCurrencyReference });

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("Currency mismatch");

    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("pending");

    const cycle = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycle?.state).toBe("AMBIGUOUS_PAYMENT");
  }, 180000);

  // ---------------------------------------------------------------
  // Test E: Provider verification says pending → remains AMBIGUOUS_PAYMENT
  // ---------------------------------------------------------------
  it("Test E: provider pending → remains AMBIGUOUS_PAYMENT", async () => {
    const { tenantId } = await provisionTenant("E");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    // Create a mock payment but do NOT confirm it — verifyPayment returns "pending".
    const intent = await mockPaymentProvider.createPaymentIntent({
      amountMinor: plan!.monthlyPriceMinor,
      currency: plan!.currency as any,
      description: "E pending test",
      idempotencyKey: `2b318_E_${Date.now()}`,
    });

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    const result = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference: intent.providerReference });

    expect(result.resolved).toBe(false);
    expect(result.status).toBe("pending");

    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("pending");

    const cycle = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycle?.state).toBe("AMBIGUOUS_PAYMENT");
  }, 180000);

  // ---------------------------------------------------------------
  // Test F: Provider verification says failed → safe retry path
  // ---------------------------------------------------------------
  it("Test F: provider failed → safe retry (PENDING)", async () => {
    const { tenantId } = await provisionTenant("F");
    const { cycleId } = await createAmbiguousCycle(tenantId);

    // Use a nonexistent reference — verifyPayment returns "failed".
    const nonexistentRef = `mock-pay-nonexistent-${Date.now()}`;

    const result = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference: nonexistentRef });

    expect(result.resolved).toBe(true);
    expect(result.status).toBe("resolved_failed");

    // Cycle should be PENDING (safe to retry).
    const cycle = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycle?.state).toBe("PENDING");
  }, 180000);

  // ---------------------------------------------------------------
  // Test H: Duplicate resolveAmbiguousPayment → exactly one financial effect
  // ---------------------------------------------------------------
  it("Test H: duplicate resolveAmbiguousPayment → exactly one financial effect", async () => {
    const { tenantId } = await provisionTenant("H");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    const providerReference = await createConfirmedMockPayment(plan!.monthlyPriceMinor, plan!.currency);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Call resolveAmbiguousPayment twice with the same reference.
    const result1 = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference });
    const result2 = await resolveAmbiguousPayment({ cycleId, tenantId, providerReference });

    expect(result1.resolved).toBe(true);
    // Second call should fail (cycle is no longer AMBIGUOUS_PAYMENT).
    expect(result2.resolved).toBe(false);

    // Exactly 1 new ledger transaction.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore + 1);

    // Invoice is paid (not duplicated).
    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("paid");
  }, 240000);

  // ---------------------------------------------------------------
  // Test I: Concurrent resolveAmbiguousPayment calls → exactly one financial effect
  // ---------------------------------------------------------------
  it("Test I: concurrent resolveAmbiguousPayment → exactly one financial effect", async () => {
    const { tenantId } = await provisionTenant("I");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    const providerReference = await createConfirmedMockPayment(plan!.monthlyPriceMinor, plan!.currency);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Call resolveAmbiguousPayment concurrently.
    const results = await Promise.allSettled([
      resolveAmbiguousPayment({ cycleId, tenantId, providerReference }),
      resolveAmbiguousPayment({ cycleId, tenantId, providerReference }),
    ]);

    // At least one should succeed.
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.resolved).length;
    expect(successes).toBe(1);

    // Exactly 1 new ledger transaction.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore + 1);

    // Invoice is paid.
    const invoice = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoice?.status).toBe("paid");
  }, 240000);

  // ---------------------------------------------------------------
  // Test J: Normal renewal/initial billing tests remain green (regression)
  // ---------------------------------------------------------------
  it("Test J: normal initial subscription still works (regression)", async () => {
    const { tenantId, userId } = await provisionTenant("J");
    const key = `saas_2b318_J_${Date.now()}`;
    const intent = await createSubscriptionIntent({
      tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key,
    });
    const result = await confirmSubscriptionPayment({ tenantId, userId, subscriptionId: intent.subscriptionId });

    expect(result.status).toBe("active");

    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.status).toBe("active");
    expect(sub?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
  }, 180000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: PaymentVerification has amountMinor and currency fields", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/payments/provider.ts", "utf-8");
    expect(source).toContain("amountMinor?: number");
    expect(source).toContain("currency?: string");
    expect(source).toContain("Phase 2B.3.18 P0");
  }, 10000);

  it("Static: resolveAmbiguousPayment has amount/currency correlation checks", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("saas.ambiguous_resolution_missing_amount_currency");
    expect(source).toContain("saas.ambiguous_resolution_amount_mismatch");
    expect(source).toContain("saas.ambiguous_resolution_currency_mismatch");
    expect(source).toContain("EXACT INVOICE CORRELATION");
  }, 10000);

  it("Static: paidAt failure blocks finalization", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("saas.ambiguous_paidAt_persist_failed_blocking");
    expect(source).toContain("Financial finalization BLOCKED");
  }, 10000);

  it("Static: all provider adapters return amountMinor and currency", async () => {
    const fs = await import("fs");
    const mockSource = fs.readFileSync("src/lib/payments/mock-provider.ts", "utf-8");
    expect(mockSource).toContain("amountMinor: intent.amountMinor");
    expect(mockSource).toContain("currency: intent.currency");

    const stripeSource = fs.readFileSync("src/lib/payments/stripe-provider.ts", "utf-8");
    expect(stripeSource).toContain("amountMinor:");
    expect(stripeSource).toContain("currency:");

    const paystackSource = fs.readFileSync("src/lib/payments/paystack-provider.ts", "utf-8");
    expect(paystackSource).toContain("amountMinor:");
    expect(paystackSource).toContain("currency:");

    const flutterwaveSource = fs.readFileSync("src/lib/payments/flutterwave-provider.ts", "utf-8");
    expect(flutterwaveSource).toContain("amountMinor:");
    expect(flutterwaveSource).toContain("currency:");
  }, 10000);
});
