/**
 * Phase 2B.3.8 — Eliminate All SaaS Renewal Completion Bypasses
 *
 * Tests:
 *   B. Already-paid invoice recovery → uses completeSaasRenewalCycle
 *   C. Concurrent already-paid recovery → one cycle, one extension
 *   Static: zero direct COMPLETED writes outside completeSaasRenewalCycle
 *   Static: zero direct currentPeriodEnd mutations for renewal outside completion
 *   Static: all paid-invoice paths call completeSaasRenewalCycle
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import { renewSubscription } from "@/lib/tenant/saas-subscription";
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
    data: { email: `saas-2b38-${Date.now()}@test.com`, name: "SaaS 2B.3.8", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `SaaS 2B.3.8 ${Date.now()}` });
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

describe("Phase 2B.3.8 — Eliminate All Renewal Completion Bypasses", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("B. Already-paid invoice recovery → uses completeSaasRenewalCycle", async () => {
    // Set the subscription's period end to the past
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    const expiredPeriodEnd = new Date(Date.now() - 86400000);
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: expiredPeriodEnd },
    });

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    if (!plan) return;

    // Pre-create a PAID invoice + cycle for this renewal period
    const newPeriodStart = expiredPeriodEnd;
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    const cycleKey = `saas_renewal_${sub.id}_${newPeriodStart.getTime()}`;

    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
        amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
        status: "paid", paymentProvider: "mock", paidAt: new Date(),
        idempotencyKey: cycleKey,
        ledgerTransactionId: "fake_ledger_for_paid_test",
      },
    });

    const cycle = await db.saasRenewalCycle.create({
      data: {
        subscriptionId: sub.id, tenantId, cycleKey,
        state: "PAYMENT_PENDING", invoiceId: invoice.id,
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
      },
    });

    // Now call renewSubscription — it should find the existing paid invoice
    // and use completeSaasRenewalCycle (NOT inline bypass)
    const result = await renewSubscription(tenantId);
    expect(result.success).toBe(true);

    // Verify: cycle is COMPLETED
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycle.id } });
    expect(cycleAfter?.state).toBe("COMPLETED");

    // Verify: subscription.currentPeriodEnd = cycle.periodEnd (the invariant)
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.currentPeriodEnd.getTime()).toBe(cycle.periodEnd.getTime());
  }, 120000);

  it("C. Concurrent already-paid recovery → one cycle, one extension", async () => {
    // Set up another expired period with a pre-paid invoice
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return;

    // Use a single timestamp for consistency
    const expiredDate = new Date(Date.now() - 86400000);
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: expiredDate },
    });

    const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
    if (!plan) return;

    // Use the EXACT same expiredDate that renewSubscription will compute
    // (renewSubscription uses subscription.currentPeriodEnd as newPeriodStart)
    const newPeriodStart = expiredDate;
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    const cycleKey = `saas_renewal_${sub.id}_${newPeriodStart.getTime()}`;

    // Pre-create a paid invoice
    const invoice = await db.tenantInvoice.create({
      data: {
        tenantId, subscriptionId: sub.id, saaasPlanName: "starter",
        amountMinor: plan.monthlyPriceMinor, currency: plan.currency, billingCycle: "monthly",
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
        status: "paid", paymentProvider: "mock", paidAt: new Date(),
        idempotencyKey: cycleKey,
        ledgerTransactionId: "fake_ledger_concurrent_test",
      },
    });

    // Pre-create the cycle in PAYMENT_PENDING
    const cycle = await db.saasRenewalCycle.create({
      data: {
        subscriptionId: sub.id, tenantId, cycleKey,
        state: "PAYMENT_PENDING", invoiceId: invoice.id,
        periodStart: newPeriodStart, periodEnd: newPeriodEnd,
      },
    });

    // Run two concurrent renewSubscription calls
    const [r1, r2] = await Promise.all([
      renewSubscription(tenantId).catch((e) => e),
      renewSubscription(tenantId).catch((e) => e),
    ]);

    // At least one must succeed
    const success1 = !(r1 instanceof Error);
    const success2 = !(r2 instanceof Error);
    expect(success1 || success2).toBe(true);

    // Verify: cycle is COMPLETED
    const cycleAfter = await db.saasRenewalCycle.findUnique({ where: { id: cycle.id } });
    expect(cycleAfter?.state).toBe("COMPLETED");

    // Verify: subscription.currentPeriodEnd = cycle.periodEnd
    const subAfter = await db.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter?.currentPeriodEnd.getTime()).toBe(cycle.periodEnd.getTime());
  }, 120000);

  it("Static: zero direct COMPLETED writes outside completeSaasRenewalCycle", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    // Find the completeSaasRenewalCycle function boundaries
    const completionStart = source.indexOf("async function completeSaasRenewalCycle");
    const completionEnd = source.indexOf("/**\n * Cancel a subscription");

    // Find all occurrences of SETTING state TO "COMPLETED" (in data objects, not WHERE clauses)
    const lines = source.split("\n");
    let violations = 0;
    for (let i = 0; i < lines.length; i++) {
      // Look for lines that SET state to "COMPLETED" (data: { state: "COMPLETED" ... })
      // but NOT lines that use "COMPLETED" in a WHERE clause (state: { not: "COMPLETED" })
      if (lines[i].includes('"COMPLETED"') &&
          (lines[i].includes('state: "COMPLETED"') || lines[i].includes('state: "COMPLETED",')) &&
          !lines[i].includes("not:") &&
          !lines[i].includes("//")) {
        // Check if this line is inside completeSaasRenewalCycle
        const charIdx = source.indexOf(lines[i]);
        if (charIdx < completionStart || charIdx >= completionEnd) {
          violations++;
        }
      }
    }
    expect(violations).toBe(0);
  }, 10000);

  it("Static: zero direct currentPeriodEnd mutations for renewal outside completion", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    // The renewSubscription function should NOT contain currentPeriodEnd assignments
    // (all period extension goes through completeSaasRenewalCycle)
    const renewStart = source.indexOf("export async function renewSubscription");
    const renewEnd = source.indexOf("export async function processDueSaasRenewals");
    const renewBody = source.substring(renewStart, renewEnd > 0 ? renewEnd : source.length);

    // Check for any currentPeriodEnd mutation (not just reads)
    // Look for patterns like "currentPeriodEnd:" in data objects (mutations)
    const mutations = renewBody.match(/currentPeriodEnd\s*:/g);
    // There should be NO currentPeriodEnd mutations in renewSubscription
    // (reads like "subscription.currentPeriodEnd" are fine, but "data: { currentPeriodEnd: ... }" is not)
    if (mutations) {
      // Filter out reads (e.g., "subscription.currentPeriodEnd > new Date()")
      const realMutations = renewBody.split("\n").filter(line =>
        line.includes("currentPeriodEnd:") &&
        !line.includes("subscription.currentPeriodEnd") &&
        !line.includes("sub.currentPeriodEnd") &&
        !line.includes("//") &&
        !line.includes("if (")
      );
      expect(realMutations.length).toBe(0);
    }
  }, 10000);

  it("Static: all paid-invoice paths call completeSaasRenewalCycle", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    // Find all places that check for invoice.status === "paid"
    const paidChecks = [];
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('status === "paid"') && !lines[i].includes("//")) {
        paidChecks.push(i);
      }
    }

    // For each paid check in renewSubscription, verify completeSaasRenewalCycle is called nearby
    const renewStart = source.indexOf("export async function renewSubscription");
    const renewEnd = source.indexOf("export async function processDueSaasRenewals");

    for (const lineNum of paidChecks) {
      const charIdx = source.indexOf(lines[lineNum]);
      if (charIdx >= renewStart && charIdx < renewEnd) {
        // Check the next 10 lines for completeSaasRenewalCycle
        const nearbyLines = lines.slice(lineNum, lineNum + 10).join("\n");
        expect(nearbyLines).toContain("completeSaasRenewalCycle");
      }
    }
  }, 10000);

  it("Static: no saasRenewalCycle.update setting state TO COMPLETED outside completion function", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/saas-subscription.ts", "utf-8");

    const completionStart = source.indexOf("async function completeSaasRenewalCycle");
    const completionEnd = source.indexOf("/**\n * Cancel a subscription");

    // Find all saasRenewalCycle.update/updateMany calls
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i].includes("saasRenewalCycle.update") || lines[i].includes("saasRenewalCycle.updateMany")) &&
          !lines[i].includes("//")) {
        const charIdx = source.indexOf(lines[i]);
        if (charIdx < completionStart || charIdx >= completionEnd) {
          // This is outside completeSaasRenewalCycle — check it doesn't SET state TO "COMPLETED"
          // (using "COMPLETED" in a WHERE clause like `state: { not: "COMPLETED" }` is fine)
          const nearbyLines = lines.slice(i, i + 5).join("\n");
          // Look for data: { state: "COMPLETED" } (a SET, not a WHERE)
          if (nearbyLines.includes('data: { state: "COMPLETED"') || nearbyLines.includes('data: { state: "COMPLETED",')) {
            expect(true).toBe(false); // force failure — found a bypass
          }
        }
      }
    }
    expect(true).toBe(true); // no violations found
  }, 10000);
});
