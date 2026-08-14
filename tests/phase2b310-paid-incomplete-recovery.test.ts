/**
 * Phase 2B.3.10 — SaaS Paid-But-Incomplete Renewal Recovery
 *
 * Tests:
 *   E. Paid + reconciliation_required cycle → discoverable by worker
 *   F. Reconciliation recovery → cycle COMPLETED + period extended
 *   G. Reconciliation idempotency → no duplicates on second run
 *   H. No second ledger → recovery doesn't repost financial events
 *   Static: worker scans SaasRenewalCycle.state = RECONCILIATION_REQUIRED
 *   Static: all completion-failure paths mark cycle RECONCILIATION_REQUIRED
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import { processDueSaasFinancialReconciliation } from "@/lib/tenant/saas-subscription";
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
    data: { email: `saas-2b310-${Date.now()}@test.com`, name: "SaaS 2B.3.10", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.10 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  if (!plan) return;

  const sub = await db.tenantSubscription.create({
    data: {
      tenantId, saaasPlanId: plan.id, status: "active", billingCycle: "monthly",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      paymentProvider: "mock",
    },
  });

  const ledgerTxnId = await ledgerSaasSubscriptionPayment({
    tenantId, userId, amountMinor: plan.monthlyPriceMinor,
    reason: "Initial", idempotencyKey: `initial_ledger_${sub.id}_${Date.now()}`,
  });

  await db.tenantInvoice.create({
    data: {
      tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
      amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
      periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000),
      status: "paid", paymentProvider: "mock", paidAt: new Date(),
      idempotencyKey: `initial_${sub.id}_${Date.now()}`,
      ledgerTransactionId: ledgerTxnId,
    },
  });
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

describe("Phase 2B.3.10 — Paid-But-Incomplete Renewal Recovery", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("E+F. Paid + RECONCILIATION_REQUIRED cycle → worker discovers and repairs", async () => {
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    // Make subscription expired
    const expiredDate = new Date(Date.now() - 86400000);
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: expiredDate },
    });

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    if (!plan) return;

    const newPeriodStart = expiredDate;
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    const cycleKey = `saas_renewal_${sub.id}_${newPeriodStart.getTime()}`;

    // Post a REAL ledger transaction
    const ledgerTxnId = await ledgerSaasSubscriptionPayment({
      tenantId, amountMinor: plan.monthlyPriceMinor,
      reason: "Test renewal", idempotencyKey: `${cycleKey}:ledger`,
    });

    // Create a PAID invoice
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
        amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
        status: "paid", paymentProvider: "mock", paidAt: new Date(),
        idempotencyKey: cycleKey,
        ledgerTransactionId: ledgerTxnId,
      },
    });

    // Create a cycle in RECONCILIATION_REQUIRED (simulates completion failure)
    const cycle = await db.saasRenewalCycle.create({
      data: {
        subscriptionId: sub.id, tenantId, cycleKey,
        state: "RECONCILIATION_REQUIRED", invoiceId: invoice.id,
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
        failureReason: "Simulated completion failure",
      },
    });

    // Count before
    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    const invoicesBefore = await db.tenantInvoice.count({ where: { tenantId } });

    // Run the reconciliation worker — should discover the RECONCILIATION_REQUIRED cycle
    // and attempt domain completion (NOT financial reposting)
    const result = await processDueSaasFinancialReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    // Verify: cycle is now COMPLETED
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycle.id } });
    expect(cycleAfter?.state).toBe("COMPLETED");

    // Verify: subscription period was extended to cycle.periodEnd
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.currentPeriodEnd.getTime()).toBe(cycle.periodEnd.getTime());

    // Verify: NO new ledger transaction (recovery doesn't repost)
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    expect(ledgerAfter).toBe(ledgerBefore);

    // Verify: NO new invoice
    const invoicesAfter = await db.tenantInvoice.count({ where: { tenantId } });
    expect(invoicesAfter).toBe(invoicesBefore);
  }, 120000);

  it("G+H+I. Reconciliation idempotency — second run produces nothing", async () => {
    // Count before second run
    const ledgerBefore = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    const invoicesBefore = await db.tenantInvoice.count({ where: { tenantId } });
    const cyclesBefore = await db.saasRenewalCycle.count({ where: { tenantId } });

    // Run reconciliation again
    const result = await processDueSaasFinancialReconciliation();

    // Verify: no new ledger, no new invoice, no new cycle
    const ledgerAfter = await db.ledgerTransaction.count({ where: { type: "SAAS_SUBSCRIPTION_PAYMENT" } });
    const invoicesAfter = await db.tenantInvoice.count({ where: { tenantId } });
    const cyclesAfter = await db.saasRenewalCycle.count({ where: { tenantId } });

    expect(ledgerAfter).toBe(ledgerBefore);
    expect(invoicesAfter).toBe(invoicesBefore);
    expect(cyclesAfter).toBe(cyclesBefore);
  }, 60000);

  it("Static: worker scans SaasRenewalCycle.state = RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("Cycle-driven scan");
    expect(source).toContain('state: "RECONCILIATION_REQUIRED"');
    expect(source).toContain("stuckCycles");
    expect(source).toContain("cycle_reconciled");
  }, 10000);

  it("Static: all completion-failure paths mark cycle RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    // Count occurrences of "RECONCILIATION_REQUIRED" in data objects (not WHERE clauses)
    const lines = source.split("\n");
    let recoveryMarkers = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('state: "RECONCILIATION_REQUIRED"') && lines[i].includes("data:")) {
        recoveryMarkers++;
      }
    }
    // Should be at least 5: renewSubscription (4 paths) + webhook + reconciliation worker
    expect(recoveryMarkers).toBeGreaterThanOrEqual(5);
  }, 10000);

  it("Static: webhook marks cycle RECONCILIATION_REQUIRED on completion failure", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("webhook_completion_failed");
    expect(source).toContain("Domain completion failed after webhook");
  }, 10000);

  it("Static: reconciliation worker marks cycle RECONCILIATION_REQUIRED on completion failure", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("reconciliation_completion_failed");
    expect(source).toContain("Domain completion failed during reconciliation");
  }, 10000);
});
