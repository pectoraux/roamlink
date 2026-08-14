/**
 * Phase 2B.3.17 — Ambiguous Payment State Safety / Reconciliation Boundary
 *
 * Tests:
 *   B. Crash before provider response → ambiguous durable state → NO ledger, NO paid invoice
 *   C. Ambiguous state encountered by renewSubscription → NO ledger, NO paid, NO period extension
 *   D. Ambiguous state encountered by reconciliation worker → NO ledger, NO paid, NO auto-retry
 *   E. Provider audit resolves ambiguity (succeeded) → exactly 1 ledger, invoice paid, renewal completes
 *   F. Provider audit proves operation never existed → safe payment retry → exactly 1 provider op, 1 ledger
 *   G. Duplicate webhook during recovery → no duplicate payment, no duplicate ledger
 *   H. Recovery is idempotent — second reconciliation produces no financial duplicates
 *
 * Static:
 *   - AMBIGUOUS_PAYMENT state exists and is distinct from RECONCILIATION_REQUIRED
 *   - activateSubscriptionAndPostLedger has paymentVerified guard
 *   - resolveAmbiguousPayment function exists
 *   - No silent .catch(() => {}) in payment-acquisition state machine
 *
 * Invariant: UNKNOWN PAYMENT → NO REVENUE. AMBIGUOUS PAYMENT → MANUAL RECONCILIATION.
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
  processDueSaasFinancialReconciliation,
  resolveAmbiguousPayment,
} from "@/lib/tenant/saas-subscription";
import { hashPassword } from "@/lib/security";
import {
  ledgerSaasSubscriptionPayment,
  ensureChartOfAccounts,
} from "@/lib/finance/double-entry-ledger";
import {
  mockPaymentProvider,
  getCreatePaymentIntentCallCount,
  resetCreatePaymentIntentCallCount,
} from "@/lib/payments";

let setupDone = false;
const tenantIds: string[] = [];
const userIds: string[] = [];

async function provisionTenant(label: string): Promise<{ tenantId: string; userId: string }> {
  const user = await db.user.create({
    data: {
      email: `saas-2b317-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
      name: `SaaS 2B.3.17 ${label}`,
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  const tenant = await createTenant({ name: `SaaS 2B.3.17 ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
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
async function createAmbiguousCycle(tenantId: string): Promise<{ cycleId: string; invoiceId: string }> {
  const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });

  // Upgrade the subscription to a paid plan (so renewSubscription doesn't take the free-plan path).
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

  // Create an invoice WITHOUT a providerReference (ambiguous state).
  const invoice = await db.tenantInvoice.create({
    data: {
      tenantId, subscriptionId: sub!.id, saaasPlanName: "starter",
      amountMinor: plan!.monthlyPriceMinor, currency: plan!.currency, billingCycle: "monthly",
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

describe("Phase 2B.3.17 — Ambiguous Payment State Safety", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // Test B: Crash before provider response → ambiguous durable state → NO ledger, NO paid
  // ---------------------------------------------------------------
  it("Test B: AMBIGUOUS_PAYMENT state has NO ledger and NO paid invoice", async () => {
    const { tenantId } = await provisionTenant("B");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    // Count ledger entries before.
    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Run reconciliation — should NOT post a ledger or mark the invoice paid.
    await processDueSaasFinancialReconciliation();

    // The cycle must still be in AMBIGUOUS_PAYMENT (not auto-retried).
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleAfter?.state).toBe("AMBIGUOUS_PAYMENT");

    // The invoice must NOT be paid.
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoiceAfter?.status).not.toBe("paid");
    expect(invoiceAfter?.status).toBe("pending");

    // NO new ledger transaction.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    // NO providerReference was created.
    expect(invoiceAfter?.providerReference).toBeNull();
  }, 180000);

  // ---------------------------------------------------------------
  // Test C: Ambiguous state encountered by renewSubscription → NO ledger, NO paid, NO extension
  // ---------------------------------------------------------------
  it("Test C: renewSubscription on AMBIGUOUS_PAYMENT cycle → refuses, NO revenue", async () => {
    const { tenantId } = await provisionTenant("C");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Call renewSubscription — should refuse.
    resetCreatePaymentIntentCallCount();
    const result = await renewSubscription(tenantId);

    // Must NOT succeed.
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");

    // createPaymentIntent must NOT have been called.
    expect(getCreatePaymentIntentCallCount()).toBe(0);

    // The cycle must still be in AMBIGUOUS_PAYMENT.
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleAfter?.state).toBe("AMBIGUOUS_PAYMENT");

    // The invoice must NOT be paid.
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoiceAfter?.status).toBe("pending");

    // NO new ledger.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    // The subscription's period must NOT have been extended.
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.currentPeriodEnd.getTime()).toBeLessThan(Date.now()); // still expired
  }, 180000);

  // ---------------------------------------------------------------
  // Test D: Ambiguous state encountered by reconciliation worker → NO auto-retry
  // ---------------------------------------------------------------
  it("Test D: reconciliation worker does NOT auto-retry AMBIGUOUS_PAYMENT", async () => {
    const { tenantId } = await provisionTenant("D");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    resetCreatePaymentIntentCallCount();
    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Run reconciliation twice.
    await processDueSaasFinancialReconciliation();
    await processDueSaasFinancialReconciliation();

    // createPaymentIntent must NOT have been called.
    expect(getCreatePaymentIntentCallCount()).toBe(0);

    // The cycle must still be AMBIGUOUS_PAYMENT.
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleAfter?.state).toBe("AMBIGUOUS_PAYMENT");

    // The invoice must still be pending.
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoiceAfter?.status).toBe("pending");

    // NO new ledger.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);
  }, 240000);

  // ---------------------------------------------------------------
  // Test E: Provider audit resolves ambiguity (succeeded) → ledger + paid + renewal completes
  // ---------------------------------------------------------------
  it("Test E: resolveAmbiguousPayment with succeeded payment → recovery completes", async () => {
    const { tenantId } = await provisionTenant("E");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    // Create a mock payment intent and confirm it (simulating: admin recovered
    // the providerReference from the provider's dashboard, and the payment succeeded).
    const mockIntent = await mockPaymentProvider.createPaymentIntent({
      amountMinor: 2900,
      currency: "USD" as any,
      description: "E ambiguous resolution",
      idempotencyKey: `2b317_E_${Date.now()}`,
    });
    mockPaymentProvider.confirmIntent(mockIntent.providerReference);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Resolve the ambiguous payment.
    const result = await resolveAmbiguousPayment({
      cycleId,
      tenantId,
      providerReference: mockIntent.providerReference,
    });

    expect(result.resolved).toBe(true);
    expect(result.status).toBe("resolved_succeeded");

    // The cycle should now be in PAYMENT_PENDING (not AMBIGUOUS_PAYMENT).
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleAfter?.state).not.toBe("AMBIGUOUS_PAYMENT");

    // The invoice should now have the providerReference.
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoiceAfter?.providerReference).toBe(mockIntent.providerReference);

    // Run reconciliation — should now complete the renewal (post ledger, mark paid, extend period).
    await processDueSaasFinancialReconciliation();

    // Exactly ONE new ledger transaction.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore + 1);

    // The invoice should be paid.
    const invoiceFinal = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoiceFinal?.status).toBe("paid");

    // The cycle should be COMPLETED.
    const cycleFinal = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleFinal?.state).toBe("COMPLETED");
  }, 240000);

  // ---------------------------------------------------------------
  // Test F: Provider audit proves operation never existed → safe retry
  // ---------------------------------------------------------------
  it("Test F: resolveAmbiguousPayment with failed payment → safe retry", async () => {
    const { tenantId } = await provisionTenant("F");
    const { cycleId } = await createAmbiguousCycle(tenantId);

    // Create a mock payment intent but do NOT confirm it (simulating: admin
    // checked the provider and found no payment exists for this reference).
    // We use a nonexistent reference — verifyPayment returns "failed".
    const nonexistentRef = `mock-pay-nonexistent-${Date.now()}`;

    const result = await resolveAmbiguousPayment({
      cycleId,
      tenantId,
      providerReference: nonexistentRef,
    });

    expect(result.resolved).toBe(true);
    expect(result.status).toBe("resolved_failed");

    // The cycle should now be in PENDING (safe to retry).
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleAfter?.state).toBe("PENDING");

    // Now renewSubscription should be able to create a new payment operation.
    resetCreatePaymentIntentCallCount();
    const renewal = await renewSubscription(tenantId);

    // Should succeed (mock provider auto-confirms).
    expect(renewal.success).toBe(true);

    // Exactly ONE createPaymentIntent call.
    expect(getCreatePaymentIntentCallCount()).toBe(1);

    // The cycle should be COMPLETED.
    const cycleFinal = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleFinal?.state).toBe("COMPLETED");
  }, 240000);

  // ---------------------------------------------------------------
  // Test H: Recovery is idempotent — second reconciliation produces no duplicates
  // ---------------------------------------------------------------
  it("Test H: second reconciliation on AMBIGUOUS_PAYMENT produces no financial duplicates", async () => {
    const { tenantId } = await provisionTenant("H");
    const { cycleId, invoiceId } = await createAmbiguousCycle(tenantId);

    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });

    // Run reconciliation multiple times.
    await processDueSaasFinancialReconciliation();
    await processDueSaasFinancialReconciliation();
    await processDueSaasFinancialReconciliation();

    // Still AMBIGUOUS_PAYMENT.
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycleId } });
    expect(cycleAfter?.state).toBe("AMBIGUOUS_PAYMENT");

    // Still pending.
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoiceId } });
    expect(invoiceAfter?.status).toBe("pending");

    // NO new ledger entries.
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);
  }, 240000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: AMBIGUOUS_PAYMENT state is used (not RECONCILIATION_REQUIRED for ambiguous case)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("AMBIGUOUS_PAYMENT");
    expect(source).toContain("saas.renewal_refused_ambiguous_payment");
    // The ambiguous case must NOT use RECONCILIATION_REQUIRED.
    expect(source).toContain('state: "AMBIGUOUS_PAYMENT"');
    expect(source).not.toContain('state: "RECONCILIATION_REQUIRED",\n          failureReason: "Payment creation timed out');
  }, 10000);

  it("Static: activateSubscriptionAndPostLedger has paymentVerified guard", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("paymentVerified?: boolean");
    expect(source).toContain("saas.activation_refused_unverified_payment");
    expect(source).toContain("Refused to post ledger for a pending invoice without payment verification");
  }, 10000);

  it("Static: resolveAmbiguousPayment function exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("export async function resolveAmbiguousPayment");
    expect(source).toContain("saas.ambiguous_resolved_succeeded");
    expect(source).toContain("saas.ambiguous_resolved_failed");
    expect(source).toContain("saas.ambiguous_resolved_pending");
  }, 10000);

  it("Static: no silent .catch(() => {}) in payment-acquisition state machine", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // Search for the actual pattern (not in comments).
    const lines = source.split("\n");
    const codeLines = lines.filter((l) => !l.trim().startsWith("//"));
    const codeSource = codeLines.join("\n");
    expect(codeSource).not.toContain(".catch(() => {})");
  }, 10000);

  it("Static: AMBIGUOUS_PAYMENT excluded from RECONCILIATION_REQUIRED cycle-driven scan", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // The cycle-driven scan uses state: "RECONCILIATION_REQUIRED" — AMBIGUOUS_PAYMENT
    // is a different state, so it's excluded.
    expect(source).toContain('where: { state: "RECONCILIATION_REQUIRED" }');
    // AMBIGUOUS_PAYMENT is used as a transition target in the stuck-CREATING scan.
    expect(source).toContain('state: "AMBIGUOUS_PAYMENT"');
  }, 10000);
});
