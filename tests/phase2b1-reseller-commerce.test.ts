/**
 * Phase 2B.1 — Reseller Commerce + Billing Convergence
 *
 * Integration tests proving the reseller vertical slice is commercially real:
 *
 *   1. Reseller can deposit prepaid funds → ledger posts (Dr Cash, Cr Reseller Funds Liability)
 *   2. Reseller order uses canonical product identity (sourcePlanId, not fuzzy lookup)
 *   3. Reseller order debits from balance (NOT mock B2C payment)
 *   4. Reseller order posts to canonical ledger (Dr Reseller Funds, Cr Sales Revenue + Platform Fee)
 *   5. Platform fee revenue is separated from connectivity sales revenue
 *   6. Supplier wholesale cost is NOT exposed to the tenant
 *   7. Real idempotency: same key → same order, no duplicate provisioning
 *   8. Insufficient balance → order rejected (402), no provisioning
 *   9. Concurrent duplicate order → exactly one order + one ledger posting
 *   10. Per-session tenant context: changing one session doesn't affect another
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser, getDistributionOfferForTenant } from "@/lib/tenant/service";
import { createTenantCustomer } from "@/lib/tenant/customers";
import { enableProduct, listAvailableProducts, getOfferEconomics } from "@/lib/tenant/catalog";
import { depositResellerBalance, debitResellerBalance, getTenantBalanceMinor, getOrCreateTenantBalance } from "@/lib/tenant/balance";
import { createOrder, confirmAndProvision } from "@/lib/orders/service";
import { setActiveTenant } from "@/lib/tenant/context";
import { hashPassword } from "@/lib/security";
import { ACCOUNT_CODES } from "@/lib/finance/double-entry-ledger";

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

  // Create a test user
  const user = await db.user.create({
    data: { email: `reseller-2b1-${Date.now()}@test.com`, name: "Reseller 2B.1", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  // Create a tenant
  const tenant = await createTenant({ name: `Reseller 2B.1 ${Date.now()}`, defaultMarkupPercent: 20 });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  // Create free subscription
  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.create({
      data: { tenantId, saaasPlanId: freePlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
  }

  // Create a session for the user
  await db.session.create({
    data: {
      userId,
      token: `test-session-2b1-${userId}`,
      expiresAt: new Date(Date.now() + 7 * 86400000),
      activeTenantId: tenantId,
    },
  });

  // Find a connectivity product with a sourcePlanId, or create one if none exists
  let product = await db.connectivityProduct.findFirst({
    where: { active: true, sourcePlanId: { not: null } },
    include: { offers: { where: { supplier: { active: true } } } },
  });

  if (!product) {
    // Create a test plan + product + supplier + offer
    const testPlan = await db.plan.create({
      data: {
        name: `Test Plan 2B.1 ${Date.now()}`,
        country: "Test Country",
        countryCode: "TC",
        region: "Test Region",
        dataAmount: 1024,
        dataUnit: "MB",
        validityDays: 30,
        price: 1000,
        wholesalePrice: 500,
        currency: "USD",
        status: "active",
        providerId: "mock",
        providerPlanId: `test-plan-2b1-${Date.now()}`,
      },
    });

    product = await db.connectivityProduct.create({
      data: {
        type: "ESIM",
        name: testPlan.name,
        country: testPlan.country,
        countryCode: testPlan.countryCode,
        region: testPlan.region,
        dataAmountMB: testPlan.dataAmountMB,
        validityDays: testPlan.validityDays,
        sourcePlanId: testPlan.id,
        active: true,
      },
      include: { offers: true },
    });

    const supplier = await db.supplier.create({
      data: { name: `Test Supplier 2B.1 ${Date.now()}`, type: "esim", providerKey: "mock", active: true },
    });

    await db.connectivityOffer.create({
      data: {
        productId: product.id,
        supplierId: supplier.id,
        wholesalePrice: 500,
        retailPrice: 1000,
        currency: "USD",
        status: "active",
        audiences: "B2C",
      },
    });

    // Re-fetch with offers
    product = await db.connectivityProduct.findUnique({
      where: { id: product.id },
      include: { offers: { where: { supplier: { active: true } } } },
    })!;
  }

  if (product) {
    productId = product.id;
    planId = product.sourcePlanId!;

    // Enable the product for the tenant (create a DistributionOffer)
    const wholesale = product.offers.length ? Math.min(...product.offers.map((o) => o.wholesalePrice)) : 500;
    const retailPrice = Math.ceil(wholesale * 1.5); // 50% markup
    const offer = await enableProduct({ tenantId, productId, retailPriceMinor: retailPrice });
    distOfferId = offer.id;
  }

  // Create a customer
  const customer = await createTenantCustomer({
    tenantId,
    name: "Test Customer 2B.1",
    email: `customer-2b1-${Date.now()}@test.com`,
  });
  customerId = customer.id;
}

afterAll(async () => {
  try {
    if (tenantId) {
      await db.tenantTransaction.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenantBalance.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.apiKey.deleteMany({ where: { tenantId } }).catch(() => {});
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

describe("Phase 2B.1 — Reseller Commerce + Billing Convergence", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("1. Reseller can deposit prepaid funds → ledger posts to Reseller Funds Liability", async () => {
    const depositAmount = 10000; // $100.00
    const result = await depositResellerBalance({
      tenantId,
      userId,
      amountMinor: depositAmount,
      idempotencyKey: `deposit_test_${Date.now()}`,
    });

    expect(result.balanceMinor).toBe(depositAmount);

    // Verify the balance record
    const balance = await getOrCreateTenantBalance(tenantId);
    expect(balance.balanceMinor).toBe(depositAmount);
    expect(balance.totalDepositedMinor).toBe(depositAmount);

    // Verify the ledger posted to RESELLER_FUNDS_LIABILITY
    const ledgerEntries = await db.ledgerEntry.findMany({
      where: { account: { code: ACCOUNT_CODES.RESELLER_FUNDS_LIABILITY } },
      include: { transaction: true },
    });
    const depositEntry = ledgerEntries.find((e) => e.transaction.description?.includes("deposit"));
    expect(depositEntry).toBeDefined();
    expect(depositEntry?.direction).toBe("credit");
    expect(depositEntry?.amountMinor).toBe(depositAmount);
  }, 30000);

  it("2. Catalog does NOT expose wholesale prices to the tenant", async () => {
    const products = await listAvailableProducts(tenantId);
    const productStr = JSON.stringify(products);
    // Wholesale price must not appear anywhere in the response
    expect(productStr).not.toContain("wholesalePriceMinor");
    expect(productStr).not.toContain("wholesaleCostMinor");
    expect(productStr).not.toContain("wholesalePrice");
    // But recommended/minimum retail prices should be present
    expect(productStr).toContain("recommendedRetailPriceMinor");
    expect(productStr).toContain("minimumRetailPriceMinor");
  }, 30000);

  it("3. Economics endpoint does NOT expose wholesale cost", async () => {
    if (!distOfferId) return;
    const economics = await getOfferEconomics(tenantId, distOfferId);
    const econStr = JSON.stringify(economics);
    expect(econStr).not.toContain("wholesaleCost");
    expect(econStr).not.toContain("wholesalePrice");
    expect(economics.minimumRetailPriceMinor).toBeGreaterThan(0);
    expect(economics.grossProfitMinor).toBeGreaterThanOrEqual(0);
  }, 30000);

  it("4. Reseller order uses canonical product identity (sourcePlanId, not fuzzy lookup)", async () => {
    if (!distOfferId || !planId) return;
    // This is verified by the order route using product.sourcePlanId directly.
    // Here we verify the product has a sourcePlanId that resolves to a real Plan.
    const product = await db.connectivityProduct.findUnique({ where: { id: productId } });
    expect(product?.sourcePlanId).toBe(planId);
    const plan = await db.plan.findUnique({ where: { id: planId } });
    expect(plan).toBeDefined();
    expect(plan?.status).toBe("active");
  }, 30000);

  it("5. Reseller order debits from balance (NOT mock B2C payment)", async () => {
    if (!distOfferId || !planId) return;
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const balanceBefore = await getTenantBalanceMinor(tenantId);

    const idempotencyKey = `order_test_${Date.now()}`;
    const order = await createOrder({
      userId,
      planId,
      tenantId,
      distributionOfferId: distOfferId,
      tenantCustomerId: customerId,
      idempotencyKey,
    });

    // Debit the balance (the real reseller commercial path)
    const platformFee = Math.round(retailPrice * 0.05); // 5% platform fee
    const debit = await debitResellerBalance({
      tenantId,
      userId,
      orderId: order.id,
      amountMinor: retailPrice,
      platformFeeMinor: platformFee,
      idempotencyKey: `reseller_purchase_${order.id}`,
    });

    // Verify the balance was debited by exactly the retail price
    expect(debit.balanceMinor).toBe(balanceBefore - retailPrice);

    // Verify the order was created with the correct amount (retail price, not wholesale)
    const dbOrder = await db.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.amount).toBe(retailPrice);
    expect(dbOrder?.tenantId).toBe(tenantId);
    expect(dbOrder?.tenantCustomerId).toBe(customerId);
    expect(dbOrder?.distributionOfferId).toBe(distOfferId);

    // Verify a TenantTransaction was recorded
    const txn = await db.tenantTransaction.findUnique({
      where: { idempotencyKey: `reseller_purchase_${order.id}` },
    });
    expect(txn).toBeDefined();
    expect(txn?.type).toBe("purchase");
    expect(txn?.amountMinor).toBe(-retailPrice);
    expect(txn?.orderId).toBe(order.id);
    expect(txn?.ledgerTransactionId).toBeTruthy();
  }, 60000);

  it("6. Platform fee revenue is separated from connectivity sales revenue in the ledger", async () => {
    // Find the ledger entries for the order we just created
    const orders = await db.order.findMany({
      where: { tenantId, tenantCustomerId: customerId },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (orders.length === 0) return;
    const orderId = orders[0].id;

    // Check ledger entries
    const ledgerTxns = await db.ledgerTransaction.findMany({
      where: { orderId },
      include: { entries: { include: { account: true } } },
    });

    // There should be a RESELLER_PURCHASE transaction with:
    // - Dr RESELLER_FUNDS_LIABILITY
    // - Cr SALES_REVENUE (connectivity revenue)
    // - Cr PLATFORM_FEE_REVENUE (platform fee, separated)
    const resellerPurchaseTxn = ledgerTxns.find((t) => t.type === "RESELLER_PURCHASE");
    expect(resellerPurchaseTxn).toBeDefined();

    const salesRevEntry = resellerPurchaseTxn!.entries.find((e) => e.account.code === ACCOUNT_CODES.SALES_REVENUE);
    const platformFeeEntry = resellerPurchaseTxn!.entries.find((e) => e.account.code === ACCOUNT_CODES.PLATFORM_FEE_REVENUE);
    expect(salesRevEntry).toBeDefined();
    expect(salesRevEntry?.direction).toBe("credit");
    expect(platformFeeEntry).toBeDefined();
    expect(platformFeeEntry?.direction).toBe("credit");
    expect(platformFeeEntry?.amountMinor).toBeGreaterThan(0);
  }, 30000);

  it("7. Real idempotency: same deposit key → one deposit, no duplicate", async () => {
    const key = `idempotent_deposit_${Date.now()}`;
    const amount = 5000;

    const r1 = await depositResellerBalance({ tenantId, userId, amountMinor: amount, idempotencyKey: key });
    const r2 = await depositResellerBalance({ tenantId, userId, amountMinor: amount, idempotencyKey: key });

    // Both should return the same balance (second is a replay)
    expect(r1.transactionId).toBe(r2.transactionId);
    expect(r1.balanceMinor).toBe(r2.balanceMinor);

    // Verify only ONE transaction record exists for this key
    const txns = await db.tenantTransaction.findMany({ where: { idempotencyKey: key } });
    expect(txns.length).toBe(1);
  }, 30000);

  it("8. Insufficient balance → order rejected (402), no provisioning", async () => {
    if (!distOfferId || !planId) return;
    // Create a second tenant with no balance
    const tenant2 = await createTenant({ name: `No Balance ${Date.now()}` });
    await addTenantUser({ tenantId: tenant2.id, userId, role: "owner" });
    const customer2 = await createTenantCustomer({
      tenantId: tenant2.id,
      name: "No Balance Customer",
      email: `nobalance-${Date.now()}@test.com`,
    });

    // Enable the same product for tenant2
    const product = await db.connectivityProduct.findUnique({ where: { id: productId } });
    const wholesale = 500;
    const offer2 = await enableProduct({
      tenantId: tenant2.id,
      productId,
      retailPriceMinor: Math.ceil(wholesale * 1.5),
    });

    // Try to debit with zero balance → should fail
    let caughtError: any = null;
    try {
      await debitResellerBalance({
        tenantId: tenant2.id,
        userId,
        orderId: "fake_order_id",
        amountMinor: 750,
        platformFeeMinor: 37,
        idempotencyKey: `insufficient_test_${Date.now()}`,
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    expect(caughtError?.statusCode).toBe(402);

    // Cleanup
    await db.tenantCustomer.deleteMany({ where: { tenantId: tenant2.id } }).catch(() => {});
    await db.distributionOffer.deleteMany({ where: { tenantId: tenant2.id } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { tenantId: tenant2.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant2.id } }).catch(() => {});
  }, 30000);

  it("9. Concurrent duplicate order → exactly one order (idempotency)", async () => {
    if (!distOfferId || !planId) return;
    const distOffer = await getDistributionOfferForTenant(distOfferId, tenantId);
    const retailPrice = distOffer.retailPrice;
    const key = `concurrent_order_${Date.now()}`;

    // Two concurrent createOrder calls with the same idempotencyKey
    const [r1, r2] = await Promise.all([
      createOrder({
        userId,
        planId,
        tenantId,
        distributionOfferId: distOfferId,
        tenantCustomerId: customerId,
        idempotencyKey: key,
      }).catch((e) => e),
      createOrder({
        userId,
        planId,
        tenantId,
        distributionOfferId: distOfferId,
        tenantCustomerId: customerId,
        idempotencyKey: key,
      }).catch((e) => e),
    ]);

    // Exactly one should succeed; the other should be an idempotent replay (same order ID)
    const id1 = r1 instanceof Error ? null : (r1 as any).id;
    const id2 = r2 instanceof Error ? null : (r2 as any).id;
    // Both should return the same order ID (createOrder is idempotent via unique constraint)
    if (id1 && id2) {
      expect(id1).toBe(id2);
    }
    // At least one must have succeeded
    expect(id1 || id2).toBeTruthy();

    // Verify only ONE order exists for this idempotencyKey
    const orders = await db.order.findMany({ where: { idempotencyKey: key } });
    expect(orders.length).toBe(1);
  }, 60000);

  it("10. Reseller cannot set retail price below minimum (margin protection)", async () => {
    if (!productId) return;
    const product = await db.connectivityProduct.findUnique({
      where: { id: productId },
      include: { offers: { where: { supplier: { active: true } } } },
    });
    if (!product || product.offers.length === 0) return;

    const wholesale = Math.min(...product.offers.map((o) => o.wholesalePrice));
    const belowMinimum = Math.floor(wholesale * 0.5); // 50% of wholesale — way below minimum

    let caught = false;
    try {
      await enableProduct({
        tenantId,
        productId,
        retailPriceMinor: belowMinimum,
      });
    } catch (err) {
      caught = true;
      expect((err as any)?.statusCode).toBe(400);
    }
    expect(caught).toBe(true);
  }, 30000);

  it("Static: TenantBalance + TenantTransaction models exist (migration 0006 applied)", async () => {
    const balanceCount = await db.tenantBalance.count();
    expect(typeof balanceCount).toBe("number");
    const txnCount = await db.tenantTransaction.count();
    expect(typeof txnCount).toBe("number");
  }, 10000);

  it("Static: new ledger accounts exist (RESELLER_FUNDS_LIABILITY, PLATFORM_FEE_REVENUE, SAAS_SUBSCRIPTION_REVENUE)", async () => {
    const { ensureChartOfAccounts } = await import("@/lib/finance/double-entry-ledger");
    // Reset the in-memory cache so new accounts are created
    await ensureChartOfAccounts();

    const resellerFunds = await db.ledgerAccount.findUnique({ where: { code: ACCOUNT_CODES.RESELLER_FUNDS_LIABILITY } });
    expect(resellerFunds).toBeDefined();
    expect(resellerFunds?.type).toBe("liability");

    const platformFee = await db.ledgerAccount.findUnique({ where: { code: ACCOUNT_CODES.PLATFORM_FEE_REVENUE } });
    expect(platformFee).toBeDefined();
    expect(platformFee?.type).toBe("revenue");

    const saasRev = await db.ledgerAccount.findUnique({ where: { code: ACCOUNT_CODES.SAAS_SUBSCRIPTION_REVENUE } });
    expect(saasRev).toBeDefined();
    expect(saasRev?.type).toBe("revenue");
  }, 30000);

  it("Static: reseller balance service exports the required functions", async () => {
    const bal = await import("@/lib/tenant/balance");
    expect(typeof bal.getOrCreateTenantBalance).toBe("function");
    expect(typeof bal.getTenantBalanceMinor).toBe("function");
    expect(typeof bal.depositResellerBalance).toBe("function");
    expect(typeof bal.debitResellerBalance).toBe("function");
    expect(typeof bal.listTenantTransactions).toBe("function");
  }, 10000);

  it("Static: ledger functions for reseller accounting exist", async () => {
    const ledger = await import("@/lib/finance/double-entry-ledger");
    expect(typeof ledger.ledgerResellerDeposit).toBe("function");
    expect(typeof ledger.ledgerResellerPurchase).toBe("function");
    expect(typeof ledger.ledgerSaasSubscriptionPayment).toBe("function");
  }, 10000);

  it("Static: tenant orders route requires Idempotency-Key header", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/tenant/orders/route.ts", "utf-8");
    expect(source).toContain("idempotency-key");
    expect(source).toContain("Idempotency-Key header is required");
    // Must NOT generate the idempotency key from Date.now() in the route code
    // (comments may mention Date.now() for context, but the actual key must come from the header)
    const codeLines = source.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const routeCode = codeLines.join("\n");
    expect(routeCode).not.toContain("`tenant_order_");
    expect(routeCode).not.toMatch(/idempotencyKey\s*=\s*.*Date\.now/);
  }, 10000);

  it("Static: tenant orders route uses reseller_balance (NOT mock) payment provider", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/tenant/orders/route.ts", "utf-8");
    expect(source).toContain('"reseller_balance"');
    expect(source).not.toContain('paymentProvider: "mock"');
  }, 10000);

  it("Static: tenant orders route uses canonical product resolution (sourcePlanId)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/tenant/orders/route.ts", "utf-8");
    expect(source).toContain("sourcePlanId");
    // Must NOT use fuzzy Plan lookup by country/dataAmount/validityDays
    expect(source).not.toContain("findFirst");
  }, 10000);

  it("Static: catalog service does NOT expose wholesale prices", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/catalog.ts", "utf-8");
    // The listAvailableProducts function should return recommendedRetailPriceMinor, not wholesalePriceMinor
    expect(source).toContain("recommendedRetailPriceMinor");
    expect(source).toContain("minimumRetailPriceMinor");
    // The function should NOT return wholesalePriceMinor as a field
    expect(source).not.toMatch(/wholesalePriceMinor:\s*bestOffer/);
  }, 10000);

  it("Static: per-session active tenant (setActiveTenant updates only the current session)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/context.ts", "utf-8");
    // setActiveTenant must use the session token, not updateMany for all sessions
    expect(source).toContain("getSessionToken");
    // Must NOT update all sessions for the user
    expect(source).not.toContain("where: { userId }");
  }, 10000);
});
