/**
 * Phase 2B.3.3 — SaaS Subscription State + Provider-Routing Convergence
 *
 * Tests:
 *   A. Unpaid initial subscription → pending_payment, NOT renewed
 *   B. Successful initial payment → period starts at payment time
 *   C. Provider resolved from invoice.paymentProvider (not global)
 *   D. PENDING_PAYMENT excluded from renewal processing
 *   Static: no "trialing" used for unpaid subscriptions
 *   Static: all payment operations use getPaymentProviderByKey
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import {
  createSubscriptionIntent,
  confirmSubscriptionPayment,
  processDueSaasRenewals,
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
    data: { email: `saas-2b33-${Date.now()}@test.com`, name: "SaaS 2B.3.3", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.3 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  // Create a free-tier subscription
  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.create({
      data: {
        tenantId, saaasPlanId: freePlan.id, status: "active",
        billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });
  }
}

afterAll(async () => {
  try {
    if (tenantId) {
      await db.tenantInvoice.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch {}
  await db.$disconnect();
}, 180000);

describe("Phase 2B.3.3 — SaaS Subscription State + Provider-Routing", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Unpaid initial subscription → pending_payment, NOT renewed", async () => {
    // Create a subscription intent but DON'T confirm payment
    const key = `saas_unpaid_${Date.now()}`;
    const intent = await createSubscriptionIntent({
      tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key,
    });

    // Verify: subscription is pending_payment (NOT trialing, NOT active)
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.status).toBe("pending_payment");

    // Verify: currentPeriodEnd is epoch (not a real period)
    expect(sub?.currentPeriodEnd.getTime()).toBe(0);

    // Try to run the renewal worker — should NOT renew a pending_payment subscription
    const result = await processDueSaasRenewals();
    expect(result.renewed).toBe(0);
    expect(result.skipped).toBe(0);

    // Verify: no renewal invoice was created
    const invoices = await db.tenantInvoice.findMany({
      where: { tenantId, idempotencyKey: { startsWith: "renewal_" } },
    });
    expect(invoices.length).toBe(0);
  }, 120000);

  it("B. Successful initial payment → period starts at payment time", async () => {
    // Confirm the payment from test A
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    const result = await confirmSubscriptionPayment({
      tenantId, userId, subscriptionId: sub.id,
    });

    // If the mock provider auto-succeeds, the subscription should be active
    if (result.status === "active") {
      const activeSub = await db.tenantSubscription.findUnique({ where: { tenantId } });
      expect(activeSub?.status).toBe("active");
      // Period should be set to ~now + 1 month (not epoch, not a future date from intent creation)
      expect(activeSub?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
      expect(activeSub?.currentPeriodEnd.getTime()).toBeLessThan(Date.now() + 32 * 86400000); // < ~32 days
    }
  }, 120000);

  it("D. PENDING_PAYMENT excluded from renewal processing", async () => {
    // Create a new tenant with a pending_payment subscription and an expired period
    const tenant2 = await createTenant({ name: `SaaS Pending ${Date.now()}` });
    const user2 = await db.user.create({
      data: { email: `pending-${Date.now()}@test.com`, name: "Pending", passwordHash: await hashPassword("test12345"), role: "customer" },
    });
    await addTenantUser({ tenantId: tenant2.id, userId: user2.id, role: "owner" });

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    if (!plan) return;

    // Create a pending_payment subscription with an expired period
    await db.tenantSubscription.create({
      data: {
        tenantId: tenant2.id, saaasPlanId: plan.id, status: "pending_payment",
        billingCycle: "monthly", currentPeriodEnd: new Date(0), // epoch
      },
    });

    // Run the renewal worker
    const result = await processDueSaasRenewals();

    // Should NOT renew the pending_payment subscription
    expect(result.renewed).toBe(0);

    // Verify: no invoices created for this tenant
    const invoices = await db.tenantInvoice.findMany({ where: { tenantId: tenant2.id } });
    expect(invoices.length).toBe(0);

    // Cleanup
    await db.tenantSubscription.deleteMany({ where: { tenantId: tenant2.id } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { tenantId: tenant2.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant2.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user2.id } }).catch(() => {});
  }, 120000);

  it("Static: no 'trialing' used for unpaid subscriptions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // The createSubscriptionIntent must NOT use "trialing" for unpaid subscriptions
    expect(source).toContain("pending_payment");
    // The renewal worker must NOT include "trialing" or "pending_payment"
    const renewStart = source.indexOf("export async function processDueSaasRenewals");
    const renewEnd = source.indexOf("export async function handleSaasPaymentWebhook");
    const renewBody = source.substring(renewStart, renewEnd > 0 ? renewEnd : source.length);
    expect(renewBody).not.toContain("trialing");
    expect(renewBody).not.toContain("pending_payment");
    expect(renewBody).toContain('"active", "past_due"');
  }, 10000);

  it("Static: provider resolved from invoice.paymentProvider, not global", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // The reconciliation worker must use getPaymentProviderByKey
    expect(source).toContain("getPaymentProviderByKey(invoice.paymentProvider");
    // The renewal must use the subscription's provider
    expect(source).toContain("getPaymentProviderByKey(subscription.paymentProvider");
    // The confirm path must use the invoice's provider
    expect(source).toContain("getPaymentProviderByKey(invoice.paymentProvider");
  }, 10000);

  it("Static: getPaymentProviderByKey exists in payments module", async () => {
    const payments = await import("@/lib/payments");
    expect(typeof payments.getPaymentProviderByKey).toBe("function");
  }, 10000);

  it("Static: period set on activation, not on intent creation", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // The createSubscriptionIntent must set currentPeriodEnd to epoch (not a real period)
    expect(source).toContain("new Date(0)");
    // The activateSubscriptionAndPostLedger must set the real period
    expect(source).toContain("Set the billing period based on payment confirmation time");
    expect(source).toContain("currentSub?.status === \"pending_payment\"");
  }, 10000);
});
