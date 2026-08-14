/**
 * Phase 2B.3.13 — Make Initial Billing Period Deterministic
 *
 * Tests:
 *   A. Initial payment → activation (smoke)
 *   B. Activation failure → reconciliation_required → worker recovers
 *   C. Delayed reconciliation preserves original periodStart (== paidAt)
 *   D. Delayed reconciliation preserves original periodEnd (== paidAt + cycle)
 *   E. Second reconciliation is idempotent (same period, no drift)
 *   F. Existing invoice period is reused verbatim
 *   G. Missing ledger reference does not activate
 *   H. Dangling ledger reference does not activate
 *   I. Renewal tests remain passing (smoke)
 *
 * Static:
 *   - periodStart derived from paidAt, never new Date()
 *   - existing period is reused
 *   - LedgerTransaction existence checked inside the helper
 *   - audit log records periodSource
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
} from "@/lib/tenant/saas-subscription";
import { hashPassword } from "@/lib/security";
import {
  ledgerSaasSubscriptionPayment,
  ensureChartOfAccounts,
} from "@/lib/finance/double-entry-ledger";

let setupDone = false;
let sharedUserId: string;
const tenantIds: string[] = [];

/** Provision a fresh tenant + free-plan stub subscription for one test. */
async function provisionTenant(label: string): Promise<{ tenantId: string; userId: string }> {
  const user = await db.user.create({
    data: {
      email: `saas-2b313-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
      name: `SaaS 2B.3.13 ${label}`,
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  const tenant = await createTenant({ name: `SaaS 2B.3.13 ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
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
  return { tenantId: tenant.id, userId: user.id };
}

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();
  await ensureChartOfAccounts();
  const user = await db.user.create({
    data: {
      email: `saas-2b313-shared-${Date.now()}@test.com`,
      name: "SaaS 2B.3.13 Shared",
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  sharedUserId = user.id;
}

afterAll(async () => {
  try {
    for (const tid of tenantIds) {
      await db.saasRenewalCycle.deleteMany({ where: { tenantId: tid } }).catch((e) => console.error("cleanup:", e));
      await db.tenantInvoice.deleteMany({ where: { tenantId: tid } }).catch((e) => console.error("cleanup:", e));
      await db.tenantSubscription.deleteMany({ where: { tenantId: tid } }).catch((e) => console.error("cleanup:", e));
      await db.tenantUser.deleteMany({ where: { tenantId: tid } }).catch((e) => console.error("cleanup:", e));
      await db.tenant.deleteMany({ where: { id: tid } }).catch((e) => console.error("cleanup:", e));
    }
    if (sharedUserId) await db.user.deleteMany({ where: { id: sharedUserId } }).catch((e) => console.error("cleanup:", e));
  } catch (e) {
    console.error("afterAll:", e);
  }
  await db.$disconnect();
}, 240000);

describe("Phase 2B.3.13 — Deterministic Initial Billing Period", () => {
  beforeAll(async () => {
    await ensureSetup();
  }, 120000);

  it("A. Initial payment → activation produces a real billing period", async () => {
    const { tenantId, userId } = await provisionTenant("A");
    const key = `saas_2b313_A_${Date.now()}`;
    const intent = await createSubscriptionIntent({
      tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key,
    });
    const before = Date.now();
    const result = await confirmSubscriptionPayment({ tenantId, userId, subscriptionId: intent.subscriptionId });
    const after = Date.now();

    expect(result.status).toBe("active");

    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.status).toBe("active");

    const invoice = await db.tenantInvoice.findFirst({
      where: { subscriptionId: intent.subscriptionId, status: "paid" },
    });
    expect(invoice).toBeTruthy();
    expect(invoice!.paidAt).toBeTruthy();
    expect(invoice!.periodStart).toBeTruthy();
    expect(invoice!.periodEnd).toBeTruthy();

    // periodStart MUST equal paidAt — not the activation execution time.
    expect(invoice!.periodStart!.getTime()).toBe(invoice!.paidAt!.getTime());
    // paidAt is within the confirm call window
    expect(invoice!.paidAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(invoice!.paidAt!.getTime()).toBeLessThanOrEqual(after);

    const ledger = await db.ledgerTransaction.findUnique({ where: { id: invoice!.ledgerTransactionId! } });
    expect(ledger).toBeTruthy();
  }, 180000);

  it("B. Activation failure → reconciliation_required → worker recovers", async () => {
    const { tenantId } = await provisionTenant("B");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId,
      amountMinor: plan!.monthlyPriceMinor,
      reason: "Test 2B.3.13 B initial activation failure",
      idempotencyKey: `2b313_B_${Date.now()}:ledger`,
    });

    const paidAt = new Date();
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: null,
        periodEnd: null,
        status: "paid",
        paymentProvider: "mock",
        paidAt,
        idempotencyKey: `2b313_B_${Date.now()}`,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    const result = await processDueSaasFinancialReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).toBe("active");
    expect(subAfter?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    expect(invoiceAfter?.periodStart).toBeTruthy();
    expect(invoiceAfter?.periodEnd).toBeTruthy();
  }, 180000);

  it("C. Delayed reconciliation preserves original periodStart (== paidAt, NOT now)", async () => {
    const { tenantId } = await provisionTenant("C");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId,
      amountMinor: plan!.monthlyPriceMinor,
      reason: "Test 2B.3.13 C delayed reconciliation",
      idempotencyKey: `2b313_C_${Date.now()}:ledger`,
    });

    // T1 = 10 days ago — payment succeeded, but activation failed at the time.
    const T1 = new Date(Date.now() - 10 * 86400000);
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: null,
        periodEnd: null,
        status: "paid",
        paymentProvider: "mock",
        paidAt: T1,
        idempotencyKey: `2b313_C_${Date.now()}`,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    // T2 = now (run reconciliation 10 days after payment)
    const T2 = Date.now();
    const result = await processDueSaasFinancialReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    // C: periodStart MUST equal paidAt (T1), NOT T2.
    expect(invoiceAfter?.periodStart).toBeTruthy();
    expect(invoiceAfter!.periodStart!.getTime()).toBe(T1.getTime());
    // Sanity: T2 is at least 9 days after T1, so this is a meaningful assertion.
    expect(T2 - T1.getTime()).toBeGreaterThan(9 * 86400000);

    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).toBe("active");
  }, 180000);

  it("D. Delayed reconciliation preserves original periodEnd (== paidAt + cycle, NOT now + cycle)", async () => {
    const { tenantId } = await provisionTenant("D");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId,
      amountMinor: plan!.monthlyPriceMinor,
      reason: "Test 2B.3.13 D delayed reconciliation periodEnd",
      idempotencyKey: `2b313_D_${Date.now()}:ledger`,
    });

    // T1 = 12 days ago. Monthly plan → expected periodEnd = T1 + 1 month.
    const T1 = new Date();
    T1.setDate(T1.getDate() - 12);
    const expectedPeriodEnd = new Date(T1.getTime());
    expectedPeriodEnd.setMonth(expectedPeriodEnd.getMonth() + 1);

    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: null,
        periodEnd: null,
        status: "paid",
        paymentProvider: "mock",
        paidAt: T1,
        idempotencyKey: `2b313_D_${Date.now()}`,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    const result = await processDueSaasFinancialReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    // D: periodEnd MUST equal T1 + 1 month, NOT now + 1 month.
    expect(invoiceAfter?.periodEnd).toBeTruthy();
    expect(invoiceAfter!.periodEnd!.getTime()).toBe(expectedPeriodEnd.getTime());

    // Subscription period must match the invoice period.
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.currentPeriodEnd.getTime()).toBe(expectedPeriodEnd.getTime());

    // And it must NOT equal now + 1 month (which would be ~12 days later than expected).
    const nowPlusOneMonth = new Date();
    nowPlusOneMonth.setMonth(nowPlusOneMonth.getMonth() + 1);
    expect(subAfter!.currentPeriodEnd.getTime()).not.toBe(nowPlusOneMonth.getTime());
  }, 180000);

  it("E. Second reconciliation is idempotent — same period, no drift", async () => {
    const { tenantId } = await provisionTenant("E");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId,
      amountMinor: plan!.monthlyPriceMinor,
      reason: "Test 2B.3.13 E idempotent retry",
      idempotencyKey: `2b313_E_${Date.now()}:ledger`,
    });

    const T1 = new Date(Date.now() - 7 * 86400000);
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: null,
        periodEnd: null,
        status: "paid",
        paymentProvider: "mock",
        paidAt: T1,
        idempotencyKey: `2b313_E_${Date.now()}`,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    // First activation
    await processDueSaasFinancialReconciliation();
    const invAfter1 = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    const subAfter1 = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter1?.status).toBe("active");
    const periodStart1 = invAfter1!.periodStart!.getTime();
    const periodEnd1 = invAfter1!.periodEnd!.getTime();

    // Force the subscription back into reconciliation_required (simulating a
    // downstream drift) and run the worker again.
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required" },
    }).catch((e) => console.error("test E reset:", e));

    await processDueSaasFinancialReconciliation();
    const invAfter2 = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    const subAfter2 = await db.tenantSubscription.findUnique({ where: { tenantId } });

    // E: second activation MUST produce the SAME period.
    expect(invAfter2?.periodStart!.getTime()).toBe(periodStart1);
    expect(invAfter2?.periodEnd!.getTime()).toBe(periodEnd1);
    expect(subAfter2?.currentPeriodEnd.getTime()).toBe(periodEnd1);
  }, 240000);

  it("F. Existing invoice period is reused verbatim (not regenerated from paidAt)", async () => {
    const { tenantId } = await provisionTenant("F");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId,
      amountMinor: plan!.monthlyPriceMinor,
      reason: "Test 2B.3.13 F existing-period reuse",
      idempotencyKey: `2b313_F_${Date.now()}:ledger`,
    });

    // paidAt = T1, but the invoice already has a recorded period of (T3, T4)
    // where T3 ≠ T1. The helper MUST reuse the recorded period.
    const T1 = new Date(Date.now() - 5 * 86400000);
    const T3 = new Date(Date.now() - 3 * 86400000); // periodStart, distinct from paidAt
    const T4 = new Date(Date.now() + 27 * 86400000); // periodEnd

    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: T3,
        periodEnd: T4,
        status: "paid",
        paymentProvider: "mock",
        paidAt: T1,
        idempotencyKey: `2b313_F_${Date.now()}`,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    const result = await processDueSaasFinancialReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const invAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    // F: periodStart/periodEnd are reused verbatim — NOT regenerated from paidAt.
    expect(invAfter?.periodStart!.getTime()).toBe(T3.getTime());
    expect(invAfter?.periodEnd!.getTime()).toBe(T4.getTime());

    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).toBe("active");
    expect(subAfter?.currentPeriodEnd.getTime()).toBe(T4.getTime());
  }, 180000);

  it("G. Missing ledger reference (null ledgerTransactionId) does not activate", async () => {
    const { tenantId } = await provisionTenant("G");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const T1 = new Date();
    await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: null,
        periodEnd: null,
        status: "paid",
        paymentProvider: "mock",
        paidAt: T1,
        idempotencyKey: `2b313_G_${Date.now()}`,
        ledgerTransactionId: null, // MISSING ledger reference
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    const result = await processDueSaasFinancialReconciliation();

    // G: subscription MUST NOT activate.
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).not.toBe("active");
    // Worker should not have reported a repair for this tenant.
    expect(result.repaired).toBeLessThanOrEqual(result.retried);
  }, 180000);

  it("H. Dangling ledger reference (nonexistent ledger id) does not activate", async () => {
    const { tenantId } = await provisionTenant("H");
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub).toBeTruthy();
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    expect(plan).toBeTruthy();

    const T1 = new Date();
    const fakeLedgerId = "c0000000000000000000dangling"; // not a real LedgerTransaction

    // Verify the fake id is in fact dangling.
    const existsBefore = await db.ledgerTransaction.findUnique({ where: { id: fakeLedgerId } });
    expect(existsBefore).toBeNull();

    await db.tenantInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub!.id,
        saaasPlanName: "starter",
        amountMinor: plan!.monthlyPriceMinor,
        currency: plan!.currency,
        billingCycle: "monthly",
        periodStart: null,
        periodEnd: null,
        status: "paid",
        paymentProvider: "mock",
        paidAt: T1,
        idempotencyKey: `2b313_H_${Date.now()}`,
        ledgerTransactionId: fakeLedgerId, // DANGLING reference
      },
    });

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    await processDueSaasFinancialReconciliation();

    // H: subscription MUST NOT activate even though ledgerTransactionId is non-null.
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).not.toBe("active");
  }, 180000);

  it("I. Renewal flow remains passing (smoke)", async () => {
    const { tenantId, userId } = await provisionTenant("I");
    const key = `saas_2b313_I_${Date.now()}`;
    const intent = await createSubscriptionIntent({
      tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key,
    });
    const result = await confirmSubscriptionPayment({ tenantId, userId, subscriptionId: intent.subscriptionId });
    expect(result.status).toBe("active");

    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.status).toBe("active");

    // Force the subscription into a state where renewal is due.
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 86400000) /* 1 day ago */ },
    });

    const renewal = await renewSubscription(tenantId);
    // Renewal should either succeed or report "renewal in progress" — both are healthy.
    expect(typeof renewal.status).toBe("string");
    expect(renewal.status).not.toBe("none");

    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    // Either renewed forward or remains in a controlled state — never rolled back.
    expect(subAfter).toBeTruthy();
    if (subAfter!.status === "active") {
      // Renewal must extend the period beyond now (it was 1 day in the past).
      expect(subAfter!.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    }
  }, 240000);

  // ---------------------------------------------------------------
  // Static tests — verify the source code enforces the invariants
  // ---------------------------------------------------------------

  it("Static: activateInitialSaasSubscription no longer uses new Date() for periodStart", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    const fnStart = source.indexOf("async function activateInitialSaasSubscription");
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = source.indexOf("/**\n * Phase 2B.3.7: Complete a SaaS renewal cycle");
    const body = source.substring(fnStart, fnEnd);

    // The activation function must NOT contain `periodStart = new Date()` or
    // `new Date()` as the source of periodStart.
    expect(body).not.toContain("periodStart = new Date()");
    expect(body).not.toContain("periodStart = new Date");

    // It MUST derive periodStart from invoice.paidAt (first activation) or
    // reuse the existing inv.periodStart (retry).
    expect(body).toContain("periodStart = inv.paidAt");
    expect(body).toContain("periodStart = inv.periodStart");
  }, 10000);

  it("Static: activateInitialSaasSubscription reuses existing invoice period", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    const fnStart = source.indexOf("async function activateInitialSaasSubscription");
    const fnEnd = source.indexOf("/**\n * Phase 2B.3.7: Complete a SaaS renewal cycle");
    const body = source.substring(fnStart, fnEnd);

    expect(body).toContain("if (inv.periodStart && inv.periodEnd)");
    expect(body).toContain("periodSource = \"reused\"");
    expect(body).toContain("periodSource = \"paidAt\"");
  }, 10000);

  it("Static: activateInitialSaasSubscription verifies LedgerTransaction exists inside the helper", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    const fnStart = source.indexOf("async function activateInitialSaasSubscription");
    const fnEnd = source.indexOf("/**\n * Phase 2B.3.7: Complete a SaaS renewal cycle");
    const body = source.substring(fnStart, fnEnd);

    expect(body).toContain('SELECT id FROM "LedgerTransaction"');
    expect(body).toContain("dangling reference");
  }, 10000);

  it("Static: locked invoice SELECT includes paidAt + periodStart + periodEnd", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    const fnStart = source.indexOf("async function activateInitialSaasSubscription");
    const fnEnd = source.indexOf("/**\n * Phase 2B.3.7: Complete a SaaS renewal cycle");
    const body = source.substring(fnStart, fnEnd);

    expect(body).toContain('"paidAt", "periodStart", "periodEnd"');
  }, 10000);

  it("Static: audit log records periodSource for billing-correctness audit", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    const fnStart = source.indexOf("async function activateInitialSaasSubscription");
    const fnEnd = source.indexOf("/**\n * Phase 2B.3.7: Complete a SaaS renewal cycle");
    const body = source.substring(fnStart, fnEnd);

    expect(body).toContain("periodSource: result.periodSource");
    expect(body).toContain("periodStart: result.periodStart?.toISOString()");
  }, 10000);

  it("Static: doc comment explicitly forbids new Date() for period start", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("DETERMINISTIC BILLING PERIOD");
    expect(source).toContain("never when a");
    expect(source).toContain("refuse to activate");
  }, 10000);
});
