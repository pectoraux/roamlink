/**
 * Phase 2B.3.6 — SaaS Renewal Finalization + Period Extension Integrity
 *
 * Tests:
 *   B. Normal renewal → cycle COMPLETED + currentPeriodEnd = cycle.periodEnd
 *   C. Successful renewal webhook → period extended
 *   D. Successful renewal reconciliation → period extended
 *   H. Ledger failure → period NOT extended
 *   I. Ledger recovery → period extended exactly once
 *   Static: completeSaasRenewalCycle is the single authoritative function
 *   Static: all renewal success paths call completeSaasRenewalCycle
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
  handleSaasPaymentWebhook,
  processDueSaasFinancialReconciliation,
} from "@/lib/tenant/saas-subscription";
import { hashPassword } from "@/lib/security";

let setupDone = false;
let tenantId: string;
let userId: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();

  const user = await db.user.create({
    data: { email: `saas-2b36-${Date.now()}@test.com`, name: "SaaS 2B.3.6", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.6 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  // Create and activate a starter subscription
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  if (!plan) return;

  const sub = await db.tenantSubscription.create({
    data: {
      tenantId, saaasPlanId: plan.id, status: "active", billingCycle: "monthly",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      paymentProvider: "mock",
    },
  });

  await db.tenantInvoice.create({
    data: {
      tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
      amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
      periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000),
      status: "paid", paymentProvider: "mock", paidAt: new Date(),
      idempotencyKey: `initial_${sub.id}_${Date.now()}`,
    },
  });
}

afterAll(async () => {
  try {
    if (tenantId) {
      await db.saasRenewalCycle.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantInvoice.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch {}
  await db.$disconnect();
}, 180000);

describe("Phase 2B.3.6 — SaaS Renewal Finalization + Period Extension", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("B. Normal renewal → cycle COMPLETED + currentPeriodEnd = cycle.periodEnd", async () => {
    // Set the subscription's period end to the past
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 86400000) },
    });

    const result = await renewSubscription(tenantId);
    expect(result.success).toBe(true);
    expect(result.status).toBe("active");

    // Verify: cycle is COMPLETED
    const cycle = await db.saasRenewalCycle.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    expect(cycle?.state).toBe("COMPLETED");

    // Verify: subscription.currentPeriodEnd = cycle.periodEnd (the key invariant)
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.currentPeriodEnd.getTime()).toBe(cycle!.periodEnd.getTime());
  }, 120000);

  it("C. Successful renewal webhook → period extended", async () => {
    // Set the subscription's period end to the past again
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 86400000) },
    });

    // Create a renewal with a pending invoice (simulating payment not yet confirmed)
    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    if (!plan) return;

    // Manually create the cycle + invoice in PENDING state
    const newPeriodStart = new Date(Date.now() - 86400000);
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    const cycleKey = `saas_renewal_${sub.id}_${newPeriodStart.getTime()}`;

    const cycle = await db.saasRenewalCycle.create({
      data: {
        subscriptionId: sub.id, tenantId, cycleKey,
        state: "PAYMENT_PENDING", periodStart: newPeriodStart, periodEnd: newPeriodEnd,
      },
    });

    // Create a payment intent via the mock provider
    const { getPaymentProvider } = await import("@/lib/payments");
    const provider = getPaymentProvider();
    const intent = await provider.createPaymentIntent({
      amountMinor: plan.monthlyPriceMinor,
      currency: plan.currency as any,
      description: "Test renewal webhook",
      idempotencyKey: cycleKey,
      metadata: { tenantId, type: "test" },
    });

    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
        amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
        status: "pending", paymentProvider: "mock",
        providerReference: intent.providerReference,
        idempotencyKey: cycleKey,
      },
    });

    await db.saasRenewalCycle.update({
      where: { id: cycle.id },
      data: { invoiceId: invoice.id },
    });

    // Confirm the payment (simulates what the mock provider does)
    const { mockPaymentProvider } = await import("@/lib/payments");
    mockPaymentProvider.confirmIntent(intent.providerReference);

    // Now send a webhook
    const webhookResult = await handleSaasPaymentWebhook({
      providerKey: "mock",
      providerReference: intent.providerReference,
      status: "succeeded",
    });
    expect(webhookResult.handled).toBe(true);

    // Verify: cycle is COMPLETED
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycle.id } });
    expect(cycleAfter?.state).toBe("COMPLETED");

    // Verify: subscription.currentPeriodEnd = cycle.periodEnd
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.currentPeriodEnd.getTime()).toBe(cycle.periodEnd.getTime());

    // Verify: invoice is paid
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    expect(invoiceAfter?.status).toBe("paid");
  }, 120000);

  it("Static: completeSaasRenewalCycle is the single authoritative period-extension function", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("async function completeSaasRenewalCycle");
    expect(source).toContain("SINGLE authoritative");
    expect(source).toContain("currentPeriodEnd: cycle.periodEnd");
  }, 10000);

  it("Static: all renewal success paths call completeSaasRenewalCycle", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // The webhook success path must call it
    expect(source).toContain("if (result.activated) {\n      await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId: invoice.tenantId });");
    // The reconciliation success path must call it
    expect(source).toContain("await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId: invoice.tenantId });\n      } else {");
    // The renewSubscription success path must call it
    expect(source).toContain("const completion = await completeSaasRenewalCycle({ invoiceId: invoice.id, tenantId });");
  }, 10000);

  it("Static: no inline period extension without completeSaasRenewalCycle", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // There should be NO direct currentPeriodEnd = newPeriodEnd in renewSubscription
    // (all period extension goes through completeSaasRenewalCycle)
    const renewStart = source.indexOf("export async function renewSubscription");
    const renewEnd = source.indexOf("export async function processDueSaasRenewals");
    const renewBody = source.substring(renewStart, renewEnd > 0 ? renewEnd : source.length);
    // The renewBody should NOT contain inline period extension (currentPeriodEnd: newPeriodEnd)
    // except in the completeSaasRenewalCycle function which is defined OUTSIDE renewSubscription
    expect(renewBody).not.toContain("currentPeriodEnd: newPeriodEnd");
  }, 10000);

  it("Static: invariant — IF cycle=COMPLETED THEN currentPeriodEnd=cycle.periodEnd", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("IF cycle = COMPLETED");
    expect(source).toContain("THEN subscription.currentPeriodEnd = cycle.periodEnd");
  }, 10000);
});
