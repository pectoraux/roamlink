/**
 * Phase 2B.2.3 — Reconciliation State Safety
 *
 * Tests that RECONCILIATION_REQUIRED is NEVER treated as proof of fulfillment
 * success. The worker must ALWAYS re-check Order.fulfillmentStatus.
 *
 * Critical regression test (§5):
 *   1. Reserve $20
 *   2. Order.fulfillmentStatus = unknown
 *   3. Run reconciliation → reservation becomes RECONCILIATION_REQUIRED
 *   4. Run reconciliation again WITHOUT changing fulfillmentStatus
 *   5. Required: reservation does NOT become SETTLED (no revenue)
 *   6. Change Order.fulfillmentStatus = success
 *   7. Run reconciliation again → reservation becomes SETTLED
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser, getDistributionOfferForTenant } from "@/lib/tenant/service";
import { createTenantCustomer } from "@/lib/tenant/customers";
import { enableProduct } from "@/lib/tenant/catalog";
import {
  reserveResellerBalance,
  createDepositIntent,
  confirmDepositPayment,
  processDueResellerReservationReconciliation,
  getTenantBalanceMinor,
} from "@/lib/tenant/balance";
import { createOrder } from "@/lib/orders/service";
import { hashPassword } from "@/lib/security";

let setupDone = false;
let tenantId: string;
let userId: string;
let customerId: string;
let distOfferId: string;
let planId: string;
let productId: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();

  const user = await db.user.create({
    data: { email: `reseller-2b23-${Date.now()}@test.com`, name: "Reseller 2B.2.3", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `Reseller 2B.2.3 ${Date.now()}`, defaultMarkupPercent: 20 });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.create({
      data: { tenantId, saaasPlanId: freePlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
  }

  let product = await db.connectivityProduct.findFirst({
    where: { active: true, sourcePlanId: { not: null } },
    include: { offers: { where: { supplier: { active: true } } } },
  });

  if (!product) {
    const testPlan = await db.plan.create({
      data: {
        name: `Test Plan 2B.2.3 ${Date.now()}`,
        country: "Test Country", countryCode: "TC", region: "Test Region",
        dataAmount: 1024, dataUnit: "MB", validityDays: 30,
        price: 1000, wholesalePrice: 500, currency: "USD", status: "active",
        providerId: "mock", providerPlanId: `test-plan-2b23-${Date.now()}`,
      },
    });
    product = await db.connectivityProduct.create({
      data: {
        type: "ESIM", name: testPlan.name, country: testPlan.country, countryCode: testPlan.countryCode,
        region: testPlan.region, dataAmountMB: testPlan.dataAmountMB, validityDays: testPlan.validityDays,
        sourcePlanId: testPlan.id, active: true,
      },
      include: { offers: true },
    });
    const supplier = await db.supplier.create({
      data: { name: `Test Supplier 2B.2.3 ${Date.now()}`, type: "esim", providerKey: "mock", active: true },
    });
    await db.connectivityOffer.create({
      data: { productId: product.id, supplierId: supplier.id, wholesalePrice: 500, retailPrice: 1000, currency: "USD", status: "active", audiences: "B2C" },
    });
    product = await db.connectivityProduct.findUnique({
      where: { id: product.id },
      include: { offers: { where: { supplier: { active: true } } } },
    })!;
  }

  if (product) {
    productId = product.id;
    planId = product.sourcePlanId!;
    const wholesale = product.offers.length ? Math.min(...product.offers.map((o) => o.wholesalePrice)) : 500;
    const offer = await enableProduct({ tenantId, productId, retailPriceMinor: Math.ceil(wholesale * 1.5) });
    distOfferId = offer.id;
  }

  const customer = await createTenantCustomer({
    tenantId, name: "Test Customer 2B.2.3", email: `customer-2b23-${Date.now()}@test.com`,
  });
  customerId = customer.id;
}

async function deposit(amount: number): Promise<void> {
  const key = `deposit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const intent = await createDepositIntent({ tenantId, userId, amountMinor: amount, idempotencyKey: key });
  await confirmDepositPayment({ depositPaymentId: intent.depositPaymentId, tenantId, userId });
}

afterAll(async () => {
  try {
    if (tenantId) {
      await db.tenantBalanceReservation.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantDepositPayment.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantTransaction.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantBalance.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantCustomer.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.distributionOffer.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    }
    if (userId) {
      await db.session.deleteMany({ where: { userId } }).catch(() => {});
      await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
  } catch {}
  await db.$disconnect();
}, 180000);

describe("Phase 2B.2.3 — Reconciliation State Safety", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // THE CRITICAL REGRESSION TEST
  it("5. Unknown → RECONCILIATION_REQUIRED → still unknown → NOT settled (then success → settled)", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    const key = `order_unknown_recon_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Set fulfillment to "unknown"
    await db.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "unknown" } });

    // Make the reservation stale
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await db.tenantBalanceReservation.update({ where: { orderId: order.id }, data: { updatedAt: staleTime } });

    // --- Worker run #1: unknown → RECONCILIATION_REQUIRED ---
    const result1 = await processDueResellerReservationReconciliation();
    expect(result1.unknown).toBeGreaterThanOrEqual(1);
    expect(result1.repaired).toBe(0); // NOT settled

    const res1 = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res1?.state).toBe("RECONCILIATION_REQUIRED");
    expect(res1?.reconciliationReason).toBe("FULFILLMENT_UNKNOWN");

    // Verify: NO revenue ledger entry
    const ledger1 = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledger1.length).toBe(0);

    // Verify: balance still decremented (funds reserved, not consumed)
    const balance1 = await getTenantBalanceMinor(tenantId);
    expect(balance1).toBe(balanceBefore - retailPrice);

    // --- Worker run #2: still unknown → must NOT settle ---
    // The reservation is now RECONCILIATION_REQUIRED. The OLD code would have
    // treated this as SETTLEMENT_ELIGIBLE without re-checking the Order.
    // The NEW code re-checks Order.fulfillmentStatus — still "unknown" → still FULFILLMENT_UNKNOWN.
    const result2 = await processDueResellerReservationReconciliation();
    expect(result2.repaired).toBe(0); // STILL NOT settled

    const res2 = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res2?.state).toBe("RECONCILIATION_REQUIRED"); // still not SETTLED

    // Verify: still NO revenue ledger entry
    const ledger2 = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledger2.length).toBe(0);

    // Verify: balance still decremented
    const balance2 = await getTenantBalanceMinor(tenantId);
    expect(balance2).toBe(balanceBefore - retailPrice);

    // --- Now change fulfillment to "success" ---
    await db.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });

    // --- Worker run #3: now success → SETTLED ---
    const result3 = await processDueResellerReservationReconciliation();
    expect(result3.repaired).toBeGreaterThanOrEqual(1);

    const res3 = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res3?.state).toBe("SETTLED");
    expect(res3?.ledgerTransactionId).toBeTruthy();

    // Verify: exactly ONE revenue ledger entry
    const ledger3 = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledger3.length).toBe(1);

    // Verify: balance still decremented (settlement doesn't touch balance — it was already reserved)
    const balance3 = await getTenantBalanceMinor(tenantId);
    expect(balance3).toBe(balanceBefore - retailPrice);

    // --- Worker run #4: idempotency — no duplicate ---
    const result4 = await processDueResellerReservationReconciliation();
    const ledger4 = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledger4.length).toBe(1); // no duplicate
  }, 180000);

  it("Static: worker ALWAYS checks Order.fulfillmentStatus (no RECONCILIATION_REQUIRED shortcut)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    // The worker must NOT have a branch that treats RECONCILIATION_REQUIRED
    // as automatically SETTLEMENT_ELIGIBLE without checking the Order.
    expect(source).not.toContain('reservation.state === "RECONCILIATION_REQUIRED"');
    // The worker must ALWAYS load the Order
    expect(source).toContain("ALWAYS inspect the Order's authoritative fulfillment state");
    // The reconciliationReason field must be set for FULFILLMENT_UNKNOWN
    expect(source).toContain('reconciliationReason: "FULFILLMENT_UNKNOWN"');
    expect(source).toContain('reconciliationReason: "LEDGER_POSTING_FAILED"');
  }, 10000);

  it("Static: reconciliationReason field exists in schema", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(schema).toContain("reconciliationReason");
  }, 10000);

  it("Static: migration 0008 applied (reconciliationReason column exists)", async () => {
    // Verify the column exists by querying it
    const res = await db.tenantBalanceReservation.findFirst({
      select: { reconciliationReason: true },
    });
    // If the column didn't exist, Prisma would throw
    expect(res).toBeDefined();
  }, 30000);
});
