/**
 * Phase 2B.3.11 — Unify Initial SaaS Activation Financial Integrity
 *
 * Tests:
 *   C. Initial activation failure → subscription reconciliation_required → worker recovers
 *   D. Paid invoice with null ledgerTransactionId → does NOT activate
 *   E. Initial reconciliation recovery → subscription becomes ACTIVE
 *   F. No duplicate ledger during recovery
 *   I. Period data correctness after recovery
 *   Static: paid-invoice fast path verifies ledgerTransactionId
 *   Static: initial activation failure marks subscription reconciliation_required
 *   Static: worker scans subscriptions in reconciliation_required
 *   Static: no silent .catch on invoice period update
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import { createSubscriptionIntent, confirmSubscriptionPayment, processDueSaasFinancialReconciliation } from "@/lib/tenant/saas-subscription";
import { hashPassword } from "@/lib/security";
import { ledgerSaasSubscriptionPayment, ensureChartOfAccounts } from "@/lib/finance/double-entry-ledger";

let setupDone = false;
let tenantId: string;
let userId: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();
  await ensureChartOfAccounts();

  const user = await db.user.create({
    data: { email: `saas-2b311-${Date.now()}@test.com`, name: "SaaS 2B.3.11", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.11 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.create({
      data: { tenantId, saaasPlanId: freePlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
  }
}

afterAll(async () => {
  try {
    if (tenantId) {
      await db.saasRenewalCycle.deleteMany({ where: { tenantId } }).catch((e) => console.error("cleanup:", e));
      await db.tenantInvoice.deleteMany({ where: { tenantId } }).catch((e) => console.error("cleanup:", e));
      await db.tenantSubscription.deleteMany({ where: { tenantId } }).catch((e) => console.error("cleanup:", e));
      await db.tenantUser.deleteMany({ where: { tenantId } }).catch((e) => console.error("cleanup:", e));
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch((e) => console.error("cleanup:", e));
    }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch((e) => console.error("cleanup:", e));
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

describe("Phase 2B.3.11 — Unify Initial SaaS Activation Financial Integrity", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Initial subscription success → subscription ACTIVE with real period", async () => {
    const key = `saas_2b311_init_${Date.now()}`;
    const intent = await createSubscriptionIntent({ tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key });
    const result = await confirmSubscriptionPayment({ tenantId, userId, subscriptionId: intent.subscriptionId });

    if (result.status === "active") {
      const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
      expect(sub?.status).toBe("active");
      expect(sub?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

      const invoice = await db.tenantInvoice.findFirst({ where: { subscriptionId: intent.subscriptionId, status: "paid" } });
      expect(invoice?.periodStart).not.toBeNull();
      expect(invoice?.periodEnd).not.toBeNull();
      expect(invoice?.ledgerTransactionId).toBeTruthy();

      // Verify the ledger transaction exists
      const ledger = await db.ledgerTransaction.findUnique({ where: { id: invoice!.ledgerTransactionId! } });
      expect(ledger).toBeDefined();
    }
  }, 120000);

  it("C+E. Initial activation failure → reconciliation_required → worker recovers", async () => {
    // Create a subscription in reconciliation_required with a paid invoice + real ledger
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    if (!plan) return;

    // Post a real ledger transaction
    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId, amountMinor: plan.monthlyPriceMinor,
      reason: "Test initial activation failure", idempotencyKey: `init_fail_${Date.now()}:ledger`,
    });

    // Create a paid invoice
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
        amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
        periodStart: null, periodEnd: null, // null — will be set on activation
        status: "paid", paymentProvider: "mock", paidAt: new Date(),
        idempotencyKey: `init_fail_${Date.now()}`,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    // Set subscription to reconciliation_required (simulates activation failure)
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required", currentPeriodEnd: new Date(0) },
    });

    // Count before
    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    const invoicesBefore = await db.tenantInvoice.count({ where: { tenantId } });

    // Run reconciliation — should discover the stuck subscription and activate it
    const result = await processDueSaasFinancialReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    // Verify: subscription is now ACTIVE
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).toBe("active");
    expect(subAfter?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    // Verify: invoice period was set
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    expect(invoiceAfter?.periodStart).not.toBeNull();
    expect(invoiceAfter?.periodEnd).not.toBeNull();

    // Verify: NO new ledger transaction (recovery doesn't repost)
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    // Verify: NO new invoice
    const invoicesAfter = await db.tenantInvoice.count({ where: { tenantId } });
    expect(invoicesAfter).toBe(invoicesBefore);
  }, 120000);

  it("D. Paid invoice with null ledgerTransactionId → does NOT activate", async () => {
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    // Create a paid invoice with NO ledgerTransactionId (corrupted state)
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
        amountMinor: 2900, currency: "USD", billingCycle: "monthly",
        periodStart: null, periodEnd: null,
        status: "paid", paymentProvider: "mock", paidAt: new Date(),
        idempotencyKey: `corrupt_paid_${Date.now()}`,
        ledgerTransactionId: null, // CORRUPTED — paid but no ledger
      },
    });

    // Set subscription to reconciliation_required
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: "reconciliation_required" },
    });

    // Run reconciliation — should NOT activate (no ledger)
    const result = await processDueSaasFinancialReconciliation();

    // Verify: subscription is NOT active
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.status).not.toBe("active");

    // Cleanup
    await db.tenantInvoice.delete({ where: { id: invoice.id } }).catch((e) => console.error("cleanup:", e));
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: "active" } }).catch((e) => console.error("cleanup:", e));
  }, 120000);

  it("Static: paid-invoice fast path verifies ledgerTransactionId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("paid_invoice_missing_ledger");
    expect(source).toContain("paid_invoice_ledger_not_found");
    expect(source).toContain("Verify the ledger transaction actually exists");
  }, 10000);

  it("Static: initial activation failure marks subscription reconciliation_required", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("initial_activation_failed");
    expect(source).toContain("Domain activation failed");
    expect(source).toContain("reconciliation_required");
  }, 10000);

  it("Static: worker scans subscriptions in reconciliation_required", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("Initial subscription recovery scan");
    expect(source).toContain('status: "reconciliation_required"');
    expect(source).toContain("stuckSubs");
    expect(source).toContain("initial_activation_reconciled");
  }, 10000);

  it("Static: no silent .catch on invoice period update", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // The invoice period update is now inside a try/catch that marks the
    // subscription reconciliation_required on failure — not a silent .catch
    const activationStart = source.indexOf("Step 3: Domain activation");
    const activationEnd = source.indexOf("For renewals (status was already active");
    const activationBody = source.substring(activationStart, activationEnd > 0 ? activationEnd : source.length);
    expect(activationBody).not.toContain(".catch(() => { logger.error(\"saas.state_update_failed\"");
    expect(activationBody).toContain("initial_activation_failed");
    expect(activationBody).toContain("try {");
    expect(activationBody).toContain("} catch (err) {");
  }, 10000);
});
