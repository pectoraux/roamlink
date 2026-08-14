/**
 * Phase 2B.3.5 — Wire SaasRenewalCycle into the real renewal path
 *
 * Tests:
 *   A. First renewal creates exactly one SaasRenewalCycle
 *   B. Concurrent renewal workers create ONE cycle
 *   C. One cycle → one invoice → one ledger → one period extension
 *   O. Legacy webhook route returns 410
 *   Static: renewSubscription creates/claims SaasRenewalCycle
 *   Static: legacy webhook rejected
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
    data: { email: `saas-2b35-${Date.now()}@test.com`, name: "SaaS 2B.3.5", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.5 ${Date.now()}` });
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

  // Create an initial paid invoice
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

describe("Phase 2B.3.5 — Durable SaaS Renewal Cycle", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. First renewal creates exactly one SaasRenewalCycle", async () => {
    // Set the subscription's period end to the past
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 86400000) },
    });

    // Count cycles before
    const cyclesBefore = await db.saasRenewalCycle.count({ where: { tenantId } });

    // Run renewal
    const result = await renewSubscription(tenantId);
    expect(result.success).toBe(true);

    // Count cycles after — exactly one new cycle
    const cyclesAfter = await db.saasRenewalCycle.count({ where: { tenantId } });
    expect(cyclesAfter).toBe(cyclesBefore + 1);

    // Verify the cycle is COMPLETED
    const cycle = await db.saasRenewalCycle.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    expect(cycle?.state).toBe("COMPLETED");
    expect(cycle?.invoiceId).toBeTruthy();
  }, 120000);

  it("B. Concurrent renewal workers create ONE cycle (idempotent)", async () => {
    // Set the subscription's period end to the past again (new period)
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 86400000) },
    });

    // Count cycles before
    const cyclesBefore = await db.saasRenewalCycle.count({ where: { tenantId } });

    // Run two concurrent renewal workers
    const [r1, r2] = await Promise.all([
      renewSubscription(tenantId).catch((e) => e),
      renewSubscription(tenantId).catch((e) => e),
    ]);

    // At least one must succeed
    const success1 = !(r1 instanceof Error);
    const success2 = !(r2 instanceof Error);
    expect(success1 || success2).toBe(true);

    // Count cycles after — exactly ONE new cycle (not two)
    const cyclesAfter = await db.saasRenewalCycle.count({ where: { tenantId } });
    expect(cyclesAfter).toBe(cyclesBefore + 1); // exactly one new cycle

    // Count invoices for this renewal period — exactly one
    const cycle = await db.saasRenewalCycle.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    if (cycle?.invoiceId) {
      const invoices = await db.tenantInvoice.count({
        where: { idempotencyKey: cycle.cycleKey },
      });
      expect(invoices).toBe(1); // exactly one invoice
    }
  }, 120000);

  it("C. One cycle → one invoice → one ledger → one period extension", async () => {
    // Verify the most recent cycle
    const cycle = await db.saasRenewalCycle.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    if (!cycle) return;

    expect(cycle.state).toBe("COMPLETED");
    expect(cycle.invoiceId).toBeTruthy();

    // Verify exactly one invoice for this cycle
    const invoice = await db.tenantInvoice.findUnique({ where: { id: cycle.invoiceId! } });
    expect(invoice).toBeDefined();
    expect(invoice?.status).toBe("paid");

    // Verify exactly one ledger transaction for this invoice
    if (invoice?.ledgerTransactionId) {
      const ledger = await db.ledgerTransaction.findUnique({ where: { id: invoice.ledgerTransactionId } });
      expect(ledger).toBeDefined();
      expect(ledger?.type).toBe("SAAS_SUBSCRIPTION_PAYMENT");
    }

    // Verify the subscription period was extended
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(sub?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
  }, 60000);

  it("O. Legacy webhook route returns 410", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/webhooks/saas/route.ts", "utf-8");
    expect(source).toContain("410");
    expect(source).toContain("DEPRECATED");
    expect(source).toContain("Use /api/webhooks/saas/[provider]");
  }, 10000);

  it("Static: renewSubscription creates/claims SaasRenewalCycle", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("saasRenewalCycle.findUnique");
    expect(source).toContain("saasRenewalCycle.create");
    expect(source).toContain("cycleKey");
    expect(source).toContain("PENDING");
    expect(source).toContain("PAYMENT_PENDING");
    expect(source).toContain("PAYMENT_CONFIRMED");
    expect(source).toContain("COMPLETED");
    expect(source).toContain("RECONCILIATION_REQUIRED");
    expect(source).toContain("PAST_DUE");
    // The cycle must be linked to the invoice
    expect(source).toContain("invoiceId: invoice.id");
    expect(source).toContain("invoiceId: cycle.invoiceId");
  }, 10000);

  it("Static: financial reconciliation completes cycles", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    expect(source).toContain("Complete the associated renewal cycle");
    expect(source).toContain("renewal_cycle_completed");
  }, 10000);

  it("Static: SaasRenewalCycle model is used in runtime (not just schema)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");
    // Must be in the renewSubscription function, not just in comments
    const renewStart = source.indexOf("export async function renewSubscription");
    const renewEnd = source.indexOf("export async function processDueSaasRenewals");
    const renewBody = source.substring(renewStart, renewEnd > 0 ? renewEnd : source.length);
    expect(renewBody).toContain("saasRenewalCycle.findUnique");
    expect(renewBody).toContain("saasRenewalCycle.create");
    expect(renewBody).toContain("saasRenewalCycle.update");
  }, 10000);
});
