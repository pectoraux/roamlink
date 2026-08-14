/**
 * Phase 2B.2.4 — Settled-Projection Reconciliation
 *
 * Tests that SETTLED reservations with a missing TenantTransaction are repaired
 * by the reconciliation worker, and that stale reconciliation metadata is cleared.
 *
 *   4. Ledger success / TenantTransaction failure → repaired by worker
 *   5. Second reconciliation is idempotent (no duplicate)
 *   6. Normal settlement still works
 *   7. Stale reconciliation metadata is cleared on SETTLED
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
    data: { email: `reseller-2b24-${Date.now()}@test.com`, name: "Reseller 2B.2.4", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `Reseller 2B.2.4 ${Date.now()}`, defaultMarkupPercent: 20 });
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
        name: `Test Plan 2B.2.4 ${Date.now()}`,
        country: "Test Country", countryCode: "TC", region: "Test Region",
        dataAmount: 1024, dataUnit: "MB", validityDays: 30,
        price: 1000, wholesalePrice: 500, currency: "USD", status: "active",
        providerId: "mock", providerPlanId: `test-plan-2b24-${Date.now()}`,
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
      data: { name: `Test Supplier 2B.2.4 ${Date.now()}`, type: "esim", providerKey: "mock", active: true },
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
    tenantId, name: "Test Customer 2B.2.4", email: `customer-2b24-${Date.now()}@test.com`,
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

describe("Phase 2B.2.4 — Settled-Projection Reconciliation", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("4. Ledger success / TenantTransaction failure → repaired by worker", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    const key = `order_projection_repair_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Set fulfillment to success so settlement can proceed
    await db.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });

    // Settle the reservation (this posts the ledger + creates TenantTransaction)
    const settlement = await settleResellerReservation({ tenantId, userId, orderId: order.id });
    expect(settlement.state).toBe("SETTLED");
    expect(settlement.ledgerTransactionId).toBeTruthy();

    // Verify: exactly one ledger transaction
    const ledgerBefore = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledgerBefore.length).toBe(1);

    // Verify: TenantTransaction exists (normal settlement creates it)
    const txnKey = `settle_reserve_${order.id}`;
    const txnBefore = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    expect(txnBefore.length).toBe(1);

    // Simulate TenantTransaction failure: delete it
    await db.tenantTransaction.deleteMany({ where: { idempotencyKey: txnKey } });
    const txnDeleted = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    expect(txnDeleted.length).toBe(0); // confirmed deleted

    // Run the reconciliation worker — it should repair the missing TenantTransaction
    const result = await processDueResellerReservationReconciliation();
    expect(result.projectionRepaired).toBeGreaterThanOrEqual(1);

    // Verify: TenantTransaction is recreated
    const txnAfter = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    expect(txnAfter.length).toBe(1);

    // Verify: NO new ledger transaction (ledger was already correct)
    const ledgerAfter = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledgerAfter.length).toBe(1); // still exactly one

    // Verify: balance unchanged (settlement doesn't touch balance, and repair doesn't either)
    const balanceAfter = await getTenantBalanceMinor(tenantId);
    expect(balanceAfter).toBe(balanceBefore - retailPrice);

    // Verify: reservation remains SETTLED
    const res = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res?.state).toBe("SETTLED");
  }, 120000);

  it("5. Second reconciliation is idempotent (no duplicate TenantTransaction)", async () => {
    // Use the reservation from test 4 (now has its TenantTransaction repaired)
    const settledReservation = await db.tenantBalanceReservation.findFirst({
      where: { tenantId, state: "SETTLED" },
      orderBy: { settledAt: "desc" },
    });
    if (!settledReservation) return;

    // Count before
    const txnKey = `settle_${settledReservation.idempotencyKey}`;
    const txnBefore = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    const ledgerBefore = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: settledReservation.orderId } });

    // Run reconciliation again
    const result = await processDueResellerReservationReconciliation();

    // Count after — no duplicates
    const txnAfter = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    const ledgerAfter = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: settledReservation.orderId } });

    expect(txnAfter.length).toBe(txnBefore.length); // no duplicate
    expect(ledgerAfter.length).toBe(ledgerBefore.length); // no duplicate
  }, 60000);

  it("6. Normal settlement still works (TenantTransaction exists, no repair needed)", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;

    const key = `order_normal_settle_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    await db.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });

    const settlement = await settleResellerReservation({ tenantId, userId, orderId: order.id });
    expect(settlement.state).toBe("SETTLED");

    // Verify: exactly one ledger transaction
    const ledger = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: order.id } });
    expect(ledger.length).toBe(1);

    // Verify: exactly one TenantTransaction
    const txnKey = `settle_reserve_${order.id}`;
    const txn = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    expect(txn.length).toBe(1);

    // Run reconciliation — should NOT repair (TenantTransaction already exists)
    const result = await processDueResellerReservationReconciliation();
    // The projectionRepaired count should NOT include this reservation
    // (it already has its TenantTransaction)
    const txnAfter = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    expect(txnAfter.length).toBe(1); // still exactly one
  }, 120000);

  it("7. Stale reconciliation metadata is cleared on SETTLED", async () => {
    if (!distOfferId || !planId) return;
    await deposit(5000);
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;

    const key = `order_stale_meta_${Date.now()}`;
    const order = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: key });

    await reserveResellerBalance({
      tenantId, userId, orderId: order.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${order.id}`,
    });

    // Manually set the reservation to RECONCILIATION_REQUIRED with a reason
    await db.tenantBalanceReservation.update({
      where: { orderId: order.id },
      data: { state: "RECONCILIATION_REQUIRED", reconciliationReason: "LEDGER_POSTING_FAILED", failureReason: "Simulated failure" },
    });

    // Set fulfillment to success so the worker can settle it
    await db.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });

    // Run the reconciliation worker — it should settle and clear the metadata
    const result = await processDueResellerReservationReconciliation();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    // Verify: reservation is SETTLED with NO stale reconciliation metadata
    const res = await db.tenantBalanceReservation.findUnique({ where: { orderId: order.id } });
    expect(res?.state).toBe("SETTLED");
    expect(res?.reconciliationReason).toBeNull();
    expect(res?.failureReason).toBeNull();
    expect(res?.ledgerTransactionId).toBeTruthy();
  }, 120000);

  it("Static: worker scans SETTLED reservations for projection repair", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    expect(source).toContain("Repair SETTLED reservations that are missing their TenantTransaction");
    expect(source).toContain("projectionRepaired");
    // The repair must NOT repost the ledger
    expect(source).toContain("we do NOT repost the ledger or change the balance");
  }, 10000);

  it("Static: SETTLED transition clears reconciliationReason", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    // Both settleResellerReservation and the worker must clear reconciliationReason
    expect(source).toContain("reconciliationReason: null");
  }, 10000);

  it("Static: worker return type includes projectionRepaired", async () => {
    const bal = await import("@/lib/tenant/balance");
    const result = await bal.processDueResellerReservationReconciliation();
    expect(result).toHaveProperty("projectionRepaired");
  }, 30000);
});
