/**
 * Phase 2B.2.6 — Deterministic Ordering + No Silent Catches + Efficient Test
 *
 * Tests:
 *   A. Two sequential purchases + missing first transaction → repaired with historical balance
 *   B. Second reconciliation idempotency
 *   C. sequenceNumber is deterministic and per-tenant
 *   D. No silent .catch(() => {}) around projectionReconciled (static)
 *   E. Historical balance uses sequenceNumber, not createdAt (static)
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import {
  reserveResellerBalance,
  settleResellerReservation,
  processDueResellerReservationReconciliation,
  getTenantBalanceMinor,
  getOrCreateTenantBalance,
} from "@/lib/tenant/balance";
import { createOrder } from "@/lib/orders/service";
import { hashPassword } from "@/lib/security";
import { ACCOUNT_CODES } from "@/lib/finance/double-entry-ledger";

let setupDone = false;
let tenantId: string;
let userId: string;
let planId: string;
let distOfferId: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();

  const user = await db.user.create({
    data: { email: `reseller-2b26-${Date.now()}@test.com`, name: "Reseller 2B.2.6", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenant = await createTenant({ name: `Reseller 2B.2.6 ${Date.now()}`, defaultMarkupPercent: 20 });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.create({
      data: { tenantId, saaasPlanId: freePlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
  }

  // Create test product/plan/supplier/offer directly (faster than going through catalog)
  const testPlan = await db.plan.create({
    data: {
      name: `Test Plan 2B.2.6 ${Date.now()}`,
      country: "TC", countryCode: "TC", region: "Test",
      dataAmount: 1024, dataUnit: "MB", validityDays: 30,
      price: 1000, wholesalePrice: 500, currency: "USD", status: "active",
      providerId: "mock", providerPlanId: `test-2b26-${Date.now()}`,
    },
  });
  planId = testPlan.id;

  const product = await db.connectivityProduct.create({
    data: { type: "ESIM", name: testPlan.name, countryCode: "TC", region: "Test", dataAmountMB: 1024, validityDays: 30, sourcePlanId: testPlan.id, active: true },
  });

  const supplier = await db.supplier.create({
    data: { name: `Sup 2B.2.6 ${Date.now()}`, type: "esim", providerKey: "mock", active: true },
  });

  await db.connectivityOffer.create({
    data: { productId: product.id, supplierId: supplier.id, wholesalePrice: 500, retailPrice: 1000, currency: "USD", status: "active", audiences: "B2C" },
  });

  const distOffer = await db.distributionOffer.create({
    data: { productId: product.id, tenantId, retailPrice: 750, currency: "USD", markupPercent: 50, status: "active", audience: "B2C" },
  });
  distOfferId = distOffer.id;

  // Create a test customer directly
  await db.tenantCustomer.create({
    data: { tenantId, name: "Customer 2B.2.6", email: `cust-2b26-${Date.now()}@test.com`, status: "active" },
  });

  // Deposit funds directly into the balance (bypass the payment flow for speed)
  await db.tenantBalance.create({
    data: { tenantId, balanceMinor: 10000, totalDepositedMinor: 10000 },
  });

  // Create the deposit TenantTransaction directly
  await db.tenantTransaction.create({
    data: {
      tenantId, type: "deposit", amountMinor: 10000, balanceAfter: 10000,
      description: "Test deposit", idempotencyKey: `test_deposit_${Date.now()}`, sequenceNumber: 1,
    },
  });
}

afterAll(async () => {
  try {
    if (tenantId) {
      await db.tenantBalanceReservation.deleteMany({ where: { tenantId } }).catch(() => {});
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

describe("Phase 2B.2.6 — Deterministic Ordering + No Silent Catches", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Two sequential purchases + missing first → repaired with historical balance", async () => {
    // Balance starts at $100 (10000 cents)
    const retailPrice = 750; // $7.50

    // --- Purchase A ($7.50) ---
    const keyA = `order_2b26_a_${Date.now()}`;
    const orderA = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: (await db.tenantCustomer.findFirst({ where: { tenantId } }))!.id, idempotencyKey: keyA });
    await reserveResellerBalance({
      tenantId, userId, orderId: orderA.id, amountMinor: retailPrice,
      platformFeeMinor: 37, idempotencyKey: `reserve_${orderA.id}`,
    });
    await db.order.update({ where: { id: orderA.id }, data: { fulfillmentStatus: "success", status: "COMPLETED" } });
    const settlementA = await settleResellerReservation({ tenantId, userId, orderId: orderA.id });
    expect(settlementA.state).toBe("SETTLED");

    // Balance after A = $100 - $7.50 = $92.50
    const balanceAfterA = await getTenantBalanceMinor(tenantId);
    expect(balanceAfterA).toBe(10000 - retailPrice);

    // Wait to ensure ordering
    await new Promise((r) => setTimeout(r, 50));

    // --- Purchase B ($7.50) ---
    const keyB = `order_2b26_b_${Date.now()}`;
    const orderB = await createOrder({ userId, planId, tenantId, distributionOfferId: distOfferId, tenantCustomerId: (await db.tenantCustomer.findFirst({ where: { tenantId } }))!.id, idempotencyKey: keyB });
    await reserveResellerBalance({
      tenantId, userId, orderId: orderB.id, amountMinor: retailPrice,
      platformFeeMinor: 37, idempotencyKey: `reserve_${orderB.id}`,
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
    expect(repairedTxnA?.balanceAfter).not.toBe(balanceAfterB);
    expect(repairedTxnA?.sequenceNumber).toBeGreaterThan(0);

    // --- Verify: TenantTransaction for B is unchanged ---
    const txnKeyB = `settle_reserve_${orderB.id}`;
    const txnB = await db.tenantTransaction.findUnique({
      where: { idempotencyKey: txnKeyB },
    });
    expect(txnB?.balanceAfter).toBe(10000 - retailPrice * 2);

    // --- Verify: NO new ledger transaction ---
    const ledgerA = await db.ledgerTransaction.findMany({ where: { type: "RESELLER_PURCHASE", orderId: orderA.id } });
    expect(ledgerA.length).toBe(1);
  }, 120000);

  it("B. Second reconciliation is idempotent (no duplicate)", async () => {
    // Count settlement transactions before
    const beforeCount = await db.tenantTransaction.count({
      where: { tenantId, type: "purchase" },
    });

    // Run reconciliation again
    await processDueResellerReservationReconciliation();

    // Count after — should be the same (no new transactions)
    const afterCount = await db.tenantTransaction.count({
      where: { tenantId, type: "purchase" },
    });
    expect(afterCount).toBe(beforeCount);
  }, 60000);

  it("C. sequenceNumber is deterministic and per-tenant", async () => {
    const txns = await db.tenantTransaction.findMany({
      where: { tenantId },
      orderBy: { sequenceNumber: "asc" },
      select: { sequenceNumber: true, type: true, amountMinor: true },
    });

    // Verify sequence numbers are unique and ascending
    const seqNums = txns.map((t) => t.sequenceNumber);
    const uniqueSeqNums = new Set(seqNums);
    expect(uniqueSeqNums.size).toBe(seqNums.length); // no duplicates

    // Verify ascending
    for (let i = 1; i < seqNums.length; i++) {
      expect(seqNums[i]).toBeGreaterThan(seqNums[i - 1]);
    }

    // Verify the first transaction is the deposit (sequence 1)
    expect(txns[0]?.type).toBe("deposit");
    expect(txns[0]?.sequenceNumber).toBe(1);
  }, 30000);

  it("Static: no silent .catch(() => {}) around projectionReconciled", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    // Find all lines with projectionReconciled: true
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("projectionReconciled: true")) {
        // Check the next line — it must NOT be .catch(() => {})
        if (i + 1 < lines.length) {
          expect(lines[i + 1]).not.toContain(".catch(() => {})");
        }
      }
    }
    // Verify the logged catch helper exists
    expect(source).toContain("logProjectionUpdateFailure");
  }, 10000);

  it("Static: historical balance reconstruction uses sequenceNumber", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");
    // The repair code must use sequenceNumber for ordering, not just createdAt
    expect(source).toContain("sequenceNumber: \"desc\"");
    expect(source).toContain("getNextSequenceNumber");
    // The repair must NOT use getTenantBalanceMinor for balanceAfter
    const repairStart = source.indexOf("Phase 2B.2.6: Reconstruct the HISTORICAL balanceAfter");
    const repairEnd = source.indexOf("Repair: create the missing TenantTransaction", repairStart);
    const repairBody = source.substring(repairStart, repairEnd > 0 ? repairEnd : source.length);
    expect(repairBody).not.toContain("getTenantBalanceMinor");
  }, 10000);

  it("Static: sequenceNumber field exists in schema + migration 0010 applied", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(schema).toContain("sequenceNumber");
    expect(schema).toContain("@@unique([tenantId, sequenceNumber])");

    // Verify the column exists by querying it
    const res = await db.tenantTransaction.findFirst({
      select: { sequenceNumber: true },
    });
    expect(res).toBeDefined();
  }, 30000);
});
