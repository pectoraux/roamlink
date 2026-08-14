/**
 * Phase 2B.3.12 — Final Initial-Activation Atomicity
 *
 * Tests:
 *   A. Initial subscription success → atomic activation with real period
 *   Static: initial activation uses single $transaction with FOR UPDATE
 *   Static: both fast_path and step3 use activateInitialSaasSubscription
 *   Static: recovery-state .catch emits CRITICAL with tenantId + subscriptionId
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
    data: { email: `saas-2b312-${Date.now()}@test.com`, name: "SaaS 2B.3.12", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.12 ${Date.now()}` });
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

describe("Phase 2B.3.12 — Final Initial-Activation Atomicity", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Initial subscription success → atomic activation", async () => {
    const key = `saas_2b312_${Date.now()}`;
    const intent = await createSubscriptionIntent({ tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key });
    const result = await confirmSubscriptionPayment({ tenantId, userId, subscriptionId: intent.subscriptionId });

    expect(result.status).toBe("active");

    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.status).toBe("active");
    expect(sub?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    const invoice = await db.tenantInvoice.findFirst({ where: { subscriptionId: intent.subscriptionId, status: "paid" } });
    expect(invoice?.periodStart).not.toBeNull();
    expect(invoice?.periodEnd).not.toBeNull();
    expect(invoice?.ledgerTransactionId).toBeTruthy();

    const ledger = await db.ledgerTransaction.findUnique({ where: { id: invoice!.ledgerTransactionId! } });
    expect(ledger).toBeDefined();
  }, 120000);

  it("Static: initial activation uses single $transaction with FOR UPDATE", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("async function activateInitialSaasSubscription");
    expect(source).toContain("Phase 2B.3.12: Atomic initial SaaS subscription activation");
    expect(source).toContain("db.$transaction(async (tx) => {");
    // Must lock both invoice and subscription
    expect(source).toContain('FROM "TenantInvoice"');
    expect(source).toContain('FROM "TenantSubscription"');
    expect(source).toContain("FOR UPDATE");
  }, 10000);

  it("Static: both fast_path and step3 call activateInitialSaasSubscription", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // Both paths must call the same function
    expect(source).toContain('source: "fast_path"');
    expect(source).toContain('source: "step3"');
    // No separate inline activation code outside activateInitialSaasSubscription
    const activationFnStart = source.indexOf("async function activateInitialSaasSubscription");
    const activationFnEnd = source.indexOf("/**\n * Phase 2B.3.7: Complete a SaaS renewal cycle");
    const activationBody = source.substring(activationFnStart, activationFnEnd);
    expect(activationBody).toContain("db.$transaction");
    expect(activationBody).toContain("tx.tenantInvoice.update");
    expect(activationBody).toContain("tx.tenantSubscription.update");
  }, 10000);

  it("Static: recovery-state .catch emits CRITICAL with context", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("recovery_state_persist_failed");
    expect(source).toContain("CRITICAL: Failed to persist reconciliation_required");
    expect(source).toContain("tenantId: input.tenantId");
    expect(source).toContain("subscriptionId: input.subscriptionId");
  }, 10000);

  it("Static: no separate inline invoice period update outside activateInitialSaasSubscription", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    // The activateSubscriptionAndPostLedger function should NOT contain
    // inline tenantInvoice.update for periodStart/periodEnd — it should
    // delegate to activateInitialSaasSubscription
    const activateStart = source.indexOf("async function activateSubscriptionAndPostLedger");
    const activateEnd = source.indexOf("/**\n * Phase 2B.3.12: Atomic initial");
    const activateBody = source.substring(activateStart, activateEnd);

    // Should NOT contain direct periodStart/periodEnd update
    expect(activateBody).not.toContain("data: { periodStart, periodEnd }");
    // Should contain calls to activateInitialSaasSubscription
    expect(activateBody).toContain("activateInitialSaasSubscription");
  }, 10000);
});
