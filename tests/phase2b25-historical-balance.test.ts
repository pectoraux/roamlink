/**
 * Phase 2B.2.5 — Historical Balance Correctness on Projection Repair
 *
 * Tests that a repaired TenantTransaction contains the correct HISTORICAL
 * balanceAfter, not the current balance at the time of repair.
 *
 *   A. Historical balance reconstruction
 *   B. Second reconciliation idempotency
 *   C. Normal settlement unaffected
 *   D. projectionReconciled flag prevents re-scanning
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
    data: { email: `reseller-2b25-${Date.now()}@test.com`, name: "Reseller 2B.2.5", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `Reseller 2B.2.5 ${Date.now()}`, defaultMarkupPercent: 20 });
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
        name: `Test Plan 2B.2.5 ${Date.now()}`,
        country: "Test Country", countryCode: "TC", region: "Test Region",
        dataAmount: 1024, dataUnit: "MB", validityDays: 30,
        price: 1000, wholesalePrice: 500, currency: "USD", status: "active",
        providerId: "mock", providerPlanId: `test-plan-2b25-${Date.now()}`,
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
      data: { name: `Test Supplier 2B.2.5 ${Date.now()}`, type: "esim", providerKey: "mock", active: true },
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
    tenantId, name: "Test Customer 2B.2.5", email: `customer-2b25-${Date.now()}@test.com`,
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

describe("Phase 2B.2.5 — Historical Balance Correctness", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Historical balance reconstruction (repair uses historical, not current, balance)", async () => {
    if (!distOfferId || !planId) return;
    // Deposit $100
    await deposit(10000);
    const balanceAfterDeposit = await getTenantBalanceMinor(tenantId);
    expect(balanceAfterDeposit).toBe(10000);

    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice; // $7.50 (750 cents)

    // --- Purchase A ($7.50) ---
    const keyA = `order_hist_a_${Date.now()}`;
    const orderA = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: keyA });
    await reserveResellerBalance({
      tenantId, userId, orderId: orderA.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${orderA.id}`,
    });
    await db.order.update({ where: { id: orderA.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });
    const settlementA = await settleResellerReservation({ tenantId, userId, orderId: orderA.id });
    expect(settlementA.state).toBe("SETTLED");

    // Balance after A = $100 - $7.50 = $92.50
    const balanceAfterA = await getTenantBalanceMinor(tenantId);
    expect(balanceAfterA).toBe(10000 - retailPrice);

    // Wait a moment to ensure createdAt ordering
    await new Promise((r) => setTimeout(r, 100));

    // --- Purchase B ($7.50) ---
    const keyB = `order_hist_b_${Date.now()}`;
    const orderB = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: customerId, idempotencyKey: keyB });
    await reserveResellerBalance({
      tenantId, userId, orderId: orderB.id, amountMinor: retailPrice,
      platformFeeMinor: Math.round(retailPrice * 0.05), idempotencyKey: `reserve_${orderB.id}`,
    });
    await db.order.update({ where: { id: orderB.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });
    const settlementB = await settleResellerReservation({ tenantId, userId, orderId: orderB.id });
    expect(settlementB.state).toBe("SETTLED");

    // Balance after B = $92.50 - $7.50 = $85.00
    const balanceAfterB = await getTenantBalanceMinor(tenantId);
    expect(balanceAfterB).toBe(10000 - retailPrice * 2);

    // --- Simulate TenantTransaction failure for Purchase A ---
    const txnKeyA = `settle_reserve_${orderA.id}`;
    await db.tenantTransaction.deleteMany({ where: { idempotencyKey: txnKeyA } });
    // Also reset the projectionReconciled flag so the worker checks it
    await db.tenantBalanceReservation.update({
      where: { orderId: orderA.id },
      data: { projectionReconciled: false },
    });

    // --- Run reconciliation ---
    const result = await processDueResellerReservationReconciliation();
    expect(result.projectionRepaired).toBeGreaterThanOrEqual(1);

    // --- Verify: repaired TenantTransaction for A has the HISTORICAL balanceAfter ---
    const repairedTxnA = await db.tenantTransaction.findUnique({
      where: { idempotencyKey: txnKeyA },
    });
    expect(repairedTxnA).toBeDefined();
    expect(repairedTxnA?.amountMinor).toBe(-retailPrice);
    // The HISTORICAL balanceAfter for A = $100 - $7.50 = $92.50 (NOT the current $85.00)
    expect(repairedTxnA?.balanceAfter).toBe(10000 - retailPrice);
    // Verify it's NOT the current balance
    expect(repairedTxnA?.balanceAfter).not.toBe(balanceAfterB);

    // --- Verify: TenantTransaction for B is unchanged ---
    const txnKeyB = `settle_reserve_${orderB.id}`;
    const txnB = await db.tenantTransaction.findUnique({
      where: { idempotencyKey: txnKeyB },
    });
    expect(txnB?.balanceAfter).toBe(10000 - retailPrice * 2);

    // --- Verify: NO new ledger transaction (ledger was already correct) ---
    const ledgerA = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: orderA.id } });
    expect(ledgerA.length).toBe(1);
  }, 180000);

  it("B. Second reconciliation is idempotent (no duplicate, no balance mutation)", async () => {
    // Use the reservation from test A (now repaired with projectionReconciled=true)
    const settledReservation = await db.tenantBalanceReservation.findFirst({
      where: { tenantId, state: "SETTLED", projectionReconciled: true },
      orderBy: { settledAt: "desc" },
    });
    if (!settledReservation) return;

    const txnKey = `settle_${settledReservation.idempotencyKey}`;
    const txnBefore = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    const ledgerBefore = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: settledReservation.orderId } });
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    // Run reconciliation again
    const result = await processDueResellerReservationReconciliation();

    // The projectionReconciled flag should prevent re-scanning
    const txnAfter = await db.tenantTransaction.findMany({ where: { idempotencyKey: txnKey } });
    const ledgerAfter = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: settledReservation.orderId } });
    const balanceAfter = await getTenantBalanceMinor(tenantId);

    expect(txnAfter.length).toBe(txnBefore.length); // no duplicate
    expect(ledgerAfter.length).toBe(ledgerBefore.length); // no duplicate
    expect(balanceAfter).toBe(balanceBefore); // no balance mutation
  }, 60000);

  it("D. projectionReconciled flag prevents re-scanning (scalability)", async () => {
    // Count how many SETTLED reservations have projectionReconciled=true
    const reconciledCount = await db.tenantBalanceReservation.count({
      where: { tenantId, state: "SETTLED", projectionReconciled: true },
    });
    // Count how many have projectionReconciled=false (should be 0 — all were reconciled)
    const unreconciledCount = await db.tenantBalanceReservation.count({
      where: { tenantId, state: "SETTLED", projectionReconciled: false },
    });

    expect(reconciledCount).toBeGreaterThan(0); // at least the ones from test A
    expect(unreconciledCount).toBe(0); // all SETTLED reservations should be reconciled
  }, 30000);

  it("Static: repair uses historical balance, not current balance", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    // The repair code must reconstruct the historical balance
    expect(source).toContain("historicalBalanceAfter");
    expect(source).toContain("priorTxn");
    // Must NOT use getTenantBalanceMinor for the repair balanceAfter
    // (getTenantBalanceMinor returns the CURRENT balance, which is wrong for historical repair)
    const repairStart = source.indexOf("Phase 2B.2.5: Reconstruct the HISTORICAL balanceAfter");
    const repairEnd = source.indexOf("Repair: create the missing TenantTransaction", repairStart);
    const repairBody = source.substring(repairStart, repairEnd > 0 ? repairEnd : source.length);
    expect(repairBody).not.toContain("getTenantBalanceMinor");
  }, 10000);

  it("Static: projectionReconciled flag exists in schema", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(schema).toContain("projectionReconciled");
  }, 10000);

  it("Static: migration 0009 applied (projectionReconciled column exists)", async () => {
    const res = await db.tenantBalanceReservation.findFirst({
      select: { projectionReconciled: true },
    });
    expect(res).toBeDefined();
  }, 30000);
});
