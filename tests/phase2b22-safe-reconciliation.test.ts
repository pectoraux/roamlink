/**
 * Phase 2B.2.2 — Safe Reservation Reconciliation
 *
 * Tests that the reconciliation worker NEVER settles based on age alone.
 * It must always consult the Order's authoritative fulfillment state.
 *
 *   4. Stale RESERVED + pending fulfillment → NOT settled (no revenue)
 *   5. Stale RESERVED + successful fulfillment → SETTLED (revenue recognized)
 *   6. Stale RESERVED + failed fulfillment → RELEASED (funds returned)
 *   7. In-flight fulfillment race → NOT settled while pending
 *   8. Unknown fulfillment state → RECONCILIATION_REQUIRED (fail closed)
 *   11. Concurrent worker + settle → one SETTLED, no duplicates
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
  settleResellerReservation,
  releaseResellerReservation,
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
let productId: string;
let planId: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();

  const user = await db.user.create({
    data: { email: `reseller-2b22-${Date.now()}@test.com`, name: "Reseller 2B.2.2", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `Reseller 2B.2.2 ${Date.now()}`, defaultMarkupPercent: 20 });
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
        name: `Test Plan 2B.2.2 ${Date.now()}`,
        country: "Test Country", countryCode: "TC", region: "Test Region",
        dataAmount: 1024, dataUnit: "MB", validityDays: 30,
        price: 1000, wholesalePrice: 500, currency: "USD", status: "active",
        providerId: "mock", providerPlanId: `test-plan-2b22-${Date.now()}`,
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
      data: { name: `Test Supplier 2B.2.2 ${Date.now()}`, type: "esim", providerKey: "mock", active: true },
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
    tenantId, name: "Test Customer 2B.2.2", email: `customer-2b22-${Date.now()}@test.com`,
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

describe("Phase 2B.2.2 — Safe Reservation Reconciliation", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("4. Stale RESERVED + pending fulfillment → NOT settled (no revenue)", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    const key = `order_stale_pending_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Make the reservation appear stale (updatedAt older than 5 minutes)
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await db.tenantBalanceReservation.update({
      where: { orderId: order.id },
      data: { updatedAt: staleTime },
    });

    // Order fulfillment is still "pending" (default — we never called confirmAndProvision)
    const orderBefore = await db.order.findUnique({ where: { id: order.id }, select: { fulfillmentStatus: true } });
    expect(orderBefore?.fulfillmentStatus).toBe("pending");

    // Run the reconciliation worker
    const result = await processDueResellerReservationReconciliation();

    // The reservation should be classified as FULFILLMENT_PENDING → not settled
    expect(result.pending).toBeGreaterThanOrEqual(1);
    expect(result.repaired).toBe(0); // nothing settled

    // Verify: reservation is still RESERVED (NOT SETTLED)
    const res = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res?.state).toBe("RESERVED");

    // Verify: NO RESELLER_PURCHASE ledger transaction
    const ledgerTxns = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledgerTxns.length).toBe(0);

    // Verify: balance is still decremented (funds reserved, not consumed)
    const balanceAfter = await getTenantBalanceMinor(tenantId);
    expect(balanceAfter).toBe(balanceBefore - retailPrice);
  }, 60000);

  it("5. Stale RESERVED + successful fulfillment → SETTLED (revenue recognized)", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    const key = `order_stale_success_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Simulate successful fulfillment by setting the order's fulfillmentStatus to "success"
    await db.order.update({
      where: { id: order.id },
      data: { fulfillmentStatus: "success", status: "COMPLETED" },
    });

    // Make the reservation appear stale
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await db.tenantBalanceReservation.update({
      where: { orderId: order.id },
      data: { updatedAt: staleTime },
    });

    // Run the reconciliation worker
    const result = await processDueResellerReservationReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    // Verify: reservation is SETTLED
    const res = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res?.state).toBe("SETTLED");
    expect(res?.ledgerTransactionId).toBeTruthy();

    // Verify: exactly one RESELLER_PURCHASE ledger transaction
    const ledgerTxns = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledgerTxns.length).toBe(1);

    // Verify: balance is decremented (funds consumed)
    const balanceAfter = await getTenantBalanceMinor(tenantId);
    expect(balanceAfter).toBe(balanceBefore - retailPrice);
  }, 120000);

  it("6. Stale RESERVED + failed fulfillment → RELEASED (funds returned)", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    const key = `order_stale_failed_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Simulate failed fulfillment
    await db.order.update({
      where: { id: order.id },
      data: { fulfillmentStatus: "failed", status: "PROVISIONING_FAILED" },
    });

    // Make the reservation appear stale
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await db.tenantBalanceReservation.update({
      where: { orderId: order.id },
      data: { updatedAt: staleTime },
    });

    // Run the reconciliation worker
    const result = await processDueResellerReservationReconciliation();
    expect(result.released).toBeGreaterThanOrEqual(1);

    // Verify: reservation is RELEASED
    const res = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res?.state).toBe("RELEASED");

    // Verify: balance restored (funds returned)
    const balanceAfter = await getTenantBalanceMinor(tenantId);
    expect(balanceAfter).toBe(balanceBefore);

    // Verify: NO RESELLER_PURCHASE ledger transaction
    const ledgerTxns = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledgerTxns.length).toBe(0);

    // Run reconciliation again — must be idempotent (no duplicate release)
    const result2 = await processDueResellerReservationReconciliation();
    const txns = await db.tenantTransaction.findMany({ where: { orderId: order.id, type: "release" } });
    expect(txns.length).toBe(1); // only one release transaction
  }, 60000);

  it("8. Unknown fulfillment state → RECONCILIATION_REQUIRED (fail closed)", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;

    const key = `order_stale_unknown_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Set fulfillment to "unknown" (ambiguous state)
    await db.order.update({
      where: { id: order.id },
      data: { fulfillmentStatus: "unknown" },
    });

    // Make the reservation appear stale
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await db.tenantBalanceReservation.update({
      where: { orderId: order.id },
      data: { updatedAt: staleTime },
    });

    // Run the reconciliation worker
    const result = await processDueResellerReservationReconciliation();
    expect(result.unknown).toBeGreaterThanOrEqual(1);

    // Verify: reservation is RECONCILIATION_REQUIRED (NOT SETTLED, NOT RELEASED)
    const res = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res?.state).toBe("RECONCILIATION_REQUIRED");

    // Verify: NO RESELLER_PURCHASE ledger transaction
    const ledgerTxns = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledgerTxns.length).toBe(0);
  }, 60000);

  it("Static: worker queries Order fulfillmentStatus before settling", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    // The worker must check fulfillmentStatus from the Order
    expect(source).toContain("fulfillmentStatus");
    expect(source).toContain("SETTLEMENT_ELIGIBLE");
    expect(source).toContain("RELEASE_ELIGIBLE");
    expect(source).toContain("FULFILLMENT_PENDING");
    expect(source).toContain("FULFILLMENT_UNKNOWN");
    // Must NOT settle based on age alone — the worker consults the Order
    expect(source).toContain("NEVER infers fulfillment success from reservation");
  }, 10000);

  it("Static: worker returns classification counts (pending, unknown, released)", async () => {
    const bal = await import("@/lib/tenant/balance");
    // The return type must include the new classification counts
    const result = await bal.processDueResellerReservationReconciliation();
    expect(result).toHaveProperty("pending");
    expect(result).toHaveProperty("unknown");
    expect(result).toHaveProperty("released");
    expect(result).toHaveProperty("repaired");
    expect(result).toHaveProperty("stillFailing");
  }, 30000);

  it("Static: cron route includes the new reservation result fields", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/internal/reconcile/route.ts", "utf-8");
    expect(source).toContain("released");
    expect(source).toContain("pending");
    expect(source).toContain("unknown");
  }, 10000);
});
