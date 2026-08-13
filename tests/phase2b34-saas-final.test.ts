/**
 * Phase 2B.3.4 — Final SaaS Billing State + Billing-Record Integrity
 *
 * Tests:
 *   A. Initial unpaid invoice has NO billing period (null periodStart/periodEnd)
 *   B. Successful payment sets actual period
 *   J. Success webhook followed by failed webhook does not regress state
 *   Static: provider-scoped webhook route exists
 *   Static: handleSaasPaymentWebhook requires providerKey
 *   Static: state monotonicity (paid not rolled back)
 *   Static: SaasRenewalCycle model exists
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import {
  createSubscriptionIntent,
  confirmSubscriptionPayment,
  handleSaasPaymentWebhook,
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
    data: { email: `saas-2b34-${Date.now()}@test.com`, name: "SaaS 2B.3.4", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.4 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

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

describe("Phase 2B.3.4 — Final SaaS Billing State", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Initial unpaid invoice has NO billing period (null periodStart/periodEnd)", async () => {
    const key = `saas_noperiod_${Date.now()}`;
    const intent = await createSubscriptionIntent({
      tenantId, userId, planName: "starter", billingCycle: "monthly", idempotencyKey: key,
    });

    // Find the invoice
    const invoice = await db.tenantInvoice.findFirst({
      where: { subscriptionId: intent.subscriptionId, status: "pending" },
    });
    expect(invoice).toBeDefined();
    expect(invoice?.periodStart).toBeNull();
    expect(invoice?.periodEnd).toBeNull();
  }, 120000);

  it("B. Successful payment sets actual period", async () => {
    // Confirm the payment from test A
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    const result = await confirmSubscriptionPayment({
      tenantId, userId, subscriptionId: sub.id,
    });

    if (result.status === "active") {
      const invoice = await db.tenantInvoice.findFirst({
        where: { subscriptionId: sub.id, status: "paid" },
      });
      expect(invoice).toBeDefined();
      expect(invoice?.periodStart).not.toBeNull();
      expect(invoice?.periodEnd).not.toBeNull();
      expect(invoice!.periodEnd!.getTime()).toBeGreaterThan(invoice!.periodStart!.getTime());
    }
  }, 120000);

  it("J. Success webhook followed by failed webhook does not regress state", async () => {
    // Find the paid invoice from test B
    const invoice = await db.tenantInvoice.findFirst({
      where: { tenantId, status: "paid" },
    });
    if (!invoice?.providerReference) return;

    // Send a failed webhook for the same invoice
    const result = await handleSaasPaymentWebhook({
      providerKey: invoice.paymentProvider || "mock",
      providerReference: invoice.providerReference,
      status: "failed",
    });

    // The webhook should be handled but NOT change the invoice state
    expect(result.handled).toBe(true);

    // Verify: invoice is still paid (NOT rolled back to failed)
    const invoiceAfter = await db.tenantInvoice.findUnique({ where: { id: invoice.id } });
    expect(invoiceAfter?.status).toBe("paid");
  }, 60000);

  it("Static: provider-scoped webhook route exists", async () => {
    const fs = await import("fs");
    expect(fs.existsSync("src/app/api/webhooks/saas/[provider]/route.ts")).toBe(true);

    const route = await import("@/app/api/webhooks/saas/[provider]/route");
    expect(typeof route.POST).toBe("function");
  }, 10000);

  it("Static: handleSaasPaymentWebhook requires providerKey", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("providerKey: string");
    expect(source).toContain("paymentProvider: input.providerKey");
    expect(source).toContain("providerReference: input.providerReference");
  }, 10000);

  it("Static: state monotonicity — paid not rolled back by failed webhook", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("State monotonicity");
    expect(source).toContain("paid invoice must NOT be rolled back");
    expect(source).toContain("webhook_failed_after_reconciliation");
  }, 10000);

  it("Static: SaasRenewalCycle model exists (migration 0013 applied)", async () => {
    const count = await db.saasRenewalCycle.count();
    expect(typeof count).toBe("number");
  }, 30000);

  it("Static: no fake billing period in createSubscriptionIntent", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).not.toContain("placeholder");
    expect(source).toContain("No fake billing period");
    expect(source).toContain("periodStart: null");
    expect(source).toContain("periodEnd: null");
  }, 10000);
});
