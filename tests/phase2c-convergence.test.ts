/**
 * Phase 2C — Connectivity Orchestration Convergence integration tests.
 *
 * These tests exercise the REAL purchase path against the real SQLite
 * database (file:/home/z/my-project/db/custom.db):
 *
 *   Tenant → DistributionOffer → Canonical Product → Orchestrator
 *         → Supplier Offer → Fulfillment Adapter → Persistence → Ledger
 *
 * All 8 scenarios from the Phase 2C task spec are covered.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createOrder, initiatePayment, confirmAndProvision, fulfillOrder } from "@/lib/orders/service";
import { syncPlanToCatalog } from "@/lib/plans/service";
import { mockPaymentProvider } from "@/lib/payments";
import {
  createTenant,
  createDistributionOffer,
  getDistributionOfferForTenant,
  getTenantOrders,
  getTenantOrder,
  addTenantUser,
  assertTenantRole,
} from "@/lib/tenant/service";
import { computeProductIdentity } from "@/lib/catalog/identity";
import { selectSupplierForProduct } from "@/lib/orchestration/engine";
import { hashPassword } from "@/lib/security";
import { AppError } from "@/lib/errors";
import { ensureTestSetup } from "./setup";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let testUserId: string;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdSupplierIds: string[] = [];
const createdOfferIds: string[] = [];
const createdDistOfferIds: string[] = [];
const createdOrderIds: string[] = [];
const createdPlanIds: string[] = [];

beforeAll(async () => {
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: "test-user@roamlink.test" } });
  testUserId = user!.id;
});

afterAll(async () => {
  // Clean up test data in dependency order.
  await db.usage.deleteMany({ where: { esim: { orderId: { in: createdOrderIds } } } }).catch(() => {});
  await db.esim.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await db.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await db.ledgerEntry.deleteMany({ where: { transaction: { orderId: { in: createdOrderIds } } } }).catch(() => {});
  await db.ledgerTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await db.providerCreditReservation.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await db.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});

  await db.distributionOffer.deleteMany({ where: { id: { in: createdDistOfferIds } } }).catch(() => {});
  await db.connectivityOffer.deleteMany({ where: { id: { in: createdOfferIds } } }).catch(() => {});
  await db.connectivityProduct.deleteMany({ where: { id: { in: createdProductIds } } }).catch(() => {});
  await db.supplier.deleteMany({ where: { id: { in: createdSupplierIds } } }).catch(() => {});

  await db.tenantUser.deleteMany({ where: { tenantId: { in: createdTenantIds } } }).catch(() => {});
  await db.tenant.deleteMany({ where: { id: { in: createdTenantIds } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
  await db.plan.deleteMany({ where: { id: { in: createdPlanIds } } }).catch(() => {});

  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTenant(name: string) {
  const tenant = await createTenant({ name: `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  createdTenantIds.push(tenant.id);
  return tenant;
}

async function makeUser(email: string) {
  const user = await db.user.create({
    data: {
      email: `${email}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@roamlink.test`,
      name: email,
      passwordHash: await hashPassword("test12345"),
      role: "customer",
      emailVerified: new Date(),
    },
  });
  createdUserIds.push(user.id);
  return user;
}

// Catalog of mock eSIM plans (must match MOCK_PLANS in src/lib/esim/mock-provider.ts
// so the mock provider can actually provision them).
const MOCK_PLAN_DEFS = [
  { providerPlanId: "gh-1gb-7d", name: "Ghana 1 GB / 7 Days", country: "Ghana", countryCode: "GH", region: "Africa", dataAmount: 1024, validityDays: 7, wholesale: 150 },
  { providerPlanId: "gh-3gb-15d", name: "Ghana 3 GB / 15 Days", country: "Ghana", countryCode: "GH", region: "Africa", dataAmount: 3072, validityDays: 15, wholesale: 320 },
  { providerPlanId: "gh-10gb-30d", name: "Ghana 10 GB / 30 Days", country: "Ghana", countryCode: "GH", region: "Africa", dataAmount: 10240, validityDays: 30, wholesale: 700 },
  { providerPlanId: "gh-20gb-30d", name: "Ghana 20 GB / 30 Days", country: "Ghana", countryCode: "GH", region: "Africa", dataAmount: 20480, validityDays: 30, wholesale: 1200 },
  { providerPlanId: "tg-2gb-7d", name: "Togo 2 GB / 7 Days", country: "Togo", countryCode: "TG", region: "Africa", dataAmount: 2048, validityDays: 7, wholesale: 220 },
  { providerPlanId: "ng-3gb-7d", name: "Nigeria 3 GB / 7 Days", country: "Nigeria", countryCode: "NG", region: "Africa", dataAmount: 3072, validityDays: 7, wholesale: 300 },
  { providerPlanId: "fr-5gb-7d", name: "France 5 GB / 7 Days", country: "France", countryCode: "FR", region: "Europe", dataAmount: 5120, validityDays: 7, wholesale: 480 },
  { providerPlanId: "us-5gb-7d", name: "United States 5 GB / 7 Days", country: "United States", countryCode: "US", region: "North America", dataAmount: 5120, validityDays: 7, wholesale: 520 },
];

let makePlanCounter = 0;
async function makePlan(nameSuffix: string) {
  const def = MOCK_PLAN_DEFS[makePlanCounter % MOCK_PLAN_DEFS.length];
  makePlanCounter += 1;
  const plan = await db.plan.create({
    data: {
      providerId: `test_${nameSuffix}_${makePlanCounter}`,
      providerPlanId: def.providerPlanId,
      name: `${def.name} ${nameSuffix} ${Date.now()}`,
      country: def.country,
      countryCode: def.countryCode,
      region: def.region,
      dataAmount: def.dataAmount,
      dataUnit: "MB",
      validityDays: def.validityDays,
      price: def.wholesale + 300,
      wholesalePrice: def.wholesale,
      currency: "USD",
      status: "active",
    },
  });
  createdPlanIds.push(plan.id);
  return plan;
}

async function makeSupplier(name: string, providerKey: string) {
  const supplier = await db.supplier.create({
    data: {
      name: `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "ESIM",
      providerKey,
      redistributionPolicy: "B2C_AND_B2B",
      healthStatus: "healthy",
      active: true,
    },
  });
  createdSupplierIds.push(supplier.id);
  return supplier;
}

async function makeProduct(attrs: {
  name: string;
  country: string;
  countryCode: string;
  region: string;
  dataAmountMB: number;
  validityDays: number;
  sourcePlanId?: string;
}) {
  const identity = computeProductIdentity({
    type: "ESIM",
    name: attrs.name,
    country: attrs.country,
    countryCode: attrs.countryCode,
    region: attrs.region,
    dataAmountMB: attrs.dataAmountMB,
    validityDays: attrs.validityDays,
    capabilities: ["DATA", "ESIM"],
  });
  // If sourcePlanId provided, look up existing first (idempotent for re-runs).
  if (attrs.sourcePlanId) {
    const existing = await db.connectivityProduct.findUnique({
      where: { sourcePlanId: attrs.sourcePlanId },
    });
    if (existing) {
      createdProductIds.push(existing.id);
      return existing;
    }
  }
  const product = await db.connectivityProduct.create({
    data: {
      type: "ESIM",
      name: attrs.name,
      description: `${attrs.name} — test canonical product`,
      country: attrs.country,
      countryCode: attrs.countryCode,
      region: attrs.region,
      dataAmountMB: attrs.dataAmountMB,
      validityDays: attrs.validityDays,
      capabilities: JSON.stringify(["DATA", "ESIM"]),
      sourcePlanId: attrs.sourcePlanId ?? null,
      canonicalSpecification: identity.canonicalSpecification,
      identityHash: identity.identityHash,
      active: true,
    },
  });
  createdProductIds.push(product.id);
  return product;
}

async function makeConnectivityOffer(input: {
  productId: string;
  supplierId: string;
  wholesalePrice: number;
  retailPrice?: number;
}) {
  const offer = await db.connectivityOffer.create({
    data: {
      productId: input.productId,
      supplierId: input.supplierId,
      wholesalePrice: input.wholesalePrice,
      retailPrice: input.retailPrice ?? Math.round(input.wholesalePrice * 1.3),
      currency: "USD",
      status: "active",
      audiences: "B2C,B2B",
    },
  });
  createdOfferIds.push(offer.id);
  return offer;
}

async function checkoutAndPay(input: {
  userId: string;
  planId: string;
  tenantId?: string | null;
  distributionOfferId?: string;
}) {
  const order = await createOrder({
    userId: input.userId,
    planId: input.planId,
    tenantId: input.tenantId ?? null,
    distributionOfferId: input.distributionOfferId,
    idempotencyKey: `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
  createdOrderIds.push(order.id);

  const payment = await initiatePayment({
    orderId: order.id,
    userId: input.userId,
    idempotencyKey: `pay_${order.id}`,
  });

  mockPaymentProvider.confirmIntent(payment.paymentReference);
  const result = await confirmAndProvision({
    orderId: order.id,
    userId: input.userId,
    idempotencyKey: `confirm_${order.id}`,
  });

  return { order, payment, result };
}

function readSnapshot(order: { planSnapshot: string | null }): {
  canonicalProductId?: string;
  distributionOfferId?: string;
  retailPriceMinor?: number;
  identityHash?: string;
} {
  if (!order.planSnapshot) return {};
  try {
    return JSON.parse(order.planSnapshot);
  } catch {
    return {};
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Phase 2C — Connectivity Orchestration Convergence", () => {
  // -------------------------------------------------------------------------
  // 1. Tenant A and Tenant B see different retail prices for the same canonical product
  // -------------------------------------------------------------------------
  it("Tenant A and Tenant B see different retail prices for the same canonical product", async () => {
    const plan = await makePlan("prices");

    // Sync the plan into the catalog → canonical product.
    const synced = await syncPlanToCatalog({
      planId: plan.id,
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      wholesalePriceMinor: plan.wholesalePrice,
      currency: plan.currency,
      supplierProviderKey: "mock",
      supplierName: `Mock TenantAB ${Date.now()}`,
    });
    createdProductIds.push(synced.productId);
    createdOfferIds.push(synced.offerId);
    // (The supplier was created internally; track it for cleanup.)
    const supplier = await db.connectivityOffer.findUnique({ where: { id: synced.offerId } });
    if (supplier) createdSupplierIds.push(supplier.supplierId);

    const product = await db.connectivityProduct.findUnique({ where: { id: synced.productId } });
    if (!product) throw new Error("Product not created");

    // Create Tenant A and Tenant B.
    const tenantA = await makeTenant("TenantA-Prices");
    const tenantB = await makeTenant("TenantB-Prices");
    const userA = await makeUser("userA-prices");
    const userB = await makeUser("userB-prices");
    await addTenantUser({ tenantId: tenantA.id, userId: userA.id, role: "admin" });
    await addTenantUser({ tenantId: tenantB.id, userId: userB.id, role: "admin" });

    // Different retail prices for the SAME canonical product.
    const priceA = 1500; // $15.00
    const priceB = 2500; // $25.00
    const distA = await createDistributionOffer({
      tenantId: tenantA.id,
      productId: product.id,
      retailPriceMinor: priceA,
    });
    const distB = await createDistributionOffer({
      tenantId: tenantB.id,
      productId: product.id,
      retailPriceMinor: priceB,
    });
    createdDistOfferIds.push(distA.id, distB.id);

    // Create orders under each tenant.
    const orderARes = await createOrder({
      userId: userA.id,
      planId: plan.id,
      tenantId: tenantA.id,
      idempotencyKey: `tenantA_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderARes.id);
    const orderBRes = await createOrder({
      userId: userB.id,
      planId: plan.id,
      tenantId: tenantB.id,
      idempotencyKey: `tenantB_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderBRes.id);

    expect(orderARes.amountMinor).toBe(priceA);
    expect(orderBRes.amountMinor).toBe(priceB);
    expect(orderARes.amountMinor).not.toBe(orderBRes.amountMinor);
  }, 60000);

  // -------------------------------------------------------------------------
  // 2. Both orders resolve the same canonical product
  // -------------------------------------------------------------------------
  it("Both orders resolve the same canonical product", async () => {
    const plan = await makePlan("samecanonical");

    const synced = await syncPlanToCatalog({
      planId: plan.id,
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      wholesalePriceMinor: plan.wholesalePrice,
      currency: plan.currency,
      supplierProviderKey: "mock",
      supplierName: `Mock SameCanonical ${Date.now()}`,
    });
    createdProductIds.push(synced.productId);
    createdOfferIds.push(synced.offerId);
    const offer = await db.connectivityOffer.findUnique({ where: { id: synced.offerId } });
    if (offer) createdSupplierIds.push(offer.supplierId);

    const tenantA = await makeTenant("TenantA-SameCanonical");
    const tenantB = await makeTenant("TenantB-SameCanonical");
    const userA = await makeUser("userA-samecanonical");
    const userB = await makeUser("userB-samecanonical");
    await addTenantUser({ tenantId: tenantA.id, userId: userA.id, role: "admin" });
    await addTenantUser({ tenantId: tenantB.id, userId: userB.id, role: "admin" });

    const distA = await createDistributionOffer({
      tenantId: tenantA.id,
      productId: synced.productId,
      retailPriceMinor: 1800,
    });
    const distB = await createDistributionOffer({
      tenantId: tenantB.id,
      productId: synced.productId,
      retailPriceMinor: 2200,
    });
    createdDistOfferIds.push(distA.id, distB.id);

    const orderARes = await createOrder({
      userId: userA.id,
      planId: plan.id,
      tenantId: tenantA.id,
      idempotencyKey: `sameA_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderARes.id);
    const orderBRes = await createOrder({
      userId: userB.id,
      planId: plan.id,
      tenantId: tenantB.id,
      idempotencyKey: `sameB_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderBRes.id);

    // Both snapshots must point to the same canonicalProductId.
    expect(orderARes.canonicalProductId).toBe(synced.productId);
    expect(orderBRes.canonicalProductId).toBe(synced.productId);
    expect(orderARes.canonicalProductId).toBe(orderBRes.canonicalProductId);

    // Verify by parsing the snapshot from the DB too (for completeness).
    const orderA = await db.order.findUnique({ where: { id: orderARes.id } });
    const orderB = await db.order.findUnique({ where: { id: orderBRes.id } });
    const snapA = readSnapshot(orderA!);
    const snapB = readSnapshot(orderB!);
    expect(snapA.canonicalProductId).toBe(snapB.canonicalProductId);
  }, 60000);

  // -------------------------------------------------------------------------
  // 3. They can be fulfilled by different suppliers
  // -------------------------------------------------------------------------
  it("They can be fulfilled by different suppliers", async () => {
    const plan = await makePlan("diffsupplier");

    // Create a canonical product with TWO suppliers, each with their own offer.
    const product = await makeProduct({
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      sourcePlanId: plan.id,
    });

    const supplier1 = await makeSupplier("Supplier-One", "mock");
    const supplier2 = await makeSupplier("Supplier-Two", "mock");
    // Ensure provider credit accounts exist for both (so the orchestrator
    // doesn't trip on missing accounts).
    await db.providerCreditAccount.upsert({
      where: { provider: "mock" },
      update: {},
      create: { provider: "mock", creditLimit: 1_000_000, currency: "USD" },
    });

    // Supplier 1: cheaper (will be picked first).
    await makeConnectivityOffer({
      productId: product.id,
      supplierId: supplier1.id,
      wholesalePrice: 100,
      retailPrice: 500,
    });
    // Supplier 2: more expensive (won't be picked unless S1 is unavailable).
    const offer2 = await makeConnectivityOffer({
      productId: product.id,
      supplierId: supplier2.id,
      wholesalePrice: 300,
      retailPrice: 700,
    });

    // Create two tenants + users + distribution offers.
    const tenantA = await makeTenant("TenantA-DiffSupplier");
    const tenantB = await makeTenant("TenantB-DiffSupplier");
    const userA = await makeUser("userA-diffsupplier");
    const userB = await makeUser("userB-diffsupplier");
    await addTenantUser({ tenantId: tenantA.id, userId: userA.id, role: "admin" });
    await addTenantUser({ tenantId: tenantB.id, userId: userB.id, role: "admin" });
    const distA = await createDistributionOffer({
      tenantId: tenantA.id,
      productId: product.id,
      retailPriceMinor: 1500,
    });
    const distB = await createDistributionOffer({
      tenantId: tenantB.id,
      productId: product.id,
      retailPriceMinor: 1500,
    });
    createdDistOfferIds.push(distA.id, distB.id);

    // Order A: Supplier 1 should be selected (cheaper & healthy).
    const orderARes = await createOrder({
      userId: userA.id,
      planId: plan.id,
      tenantId: tenantA.id,
      idempotencyKey: `diffA_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderARes.id);

    // Pay + fulfill order A via the real purchase path (confirmAndProvision).
    const payA = await initiatePayment({
      orderId: orderARes.id,
      userId: userA.id,
      idempotencyKey: `payA_${orderARes.id}`,
    });
    mockPaymentProvider.confirmIntent(payA.paymentReference);
    const confirmA = await confirmAndProvision({
      orderId: orderARes.id,
      userId: userA.id,
      idempotencyKey: `confirmA_${orderARes.id}`,
    });
    expect(confirmA.esimId).toBeTruthy();

    const orderA = await db.order.findUnique({ where: { id: orderARes.id } });
    expect(orderA!.supplierOfferId).toBeTruthy();
    expect(orderA!.supplierOfferId).not.toBe(offer2.id);

    // Now deactivate Supplier 1 (set healthStatus=unhealthy) and re-create
    // order B — Supplier 2 should be selected.
    await db.supplier.update({
      where: { id: supplier1.id },
      data: { healthStatus: "unhealthy" },
    });

    const orderBRes = await createOrder({
      userId: userB.id,
      planId: plan.id,
      tenantId: tenantB.id,
      idempotencyKey: `diffB_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderBRes.id);

    const payB = await initiatePayment({
      orderId: orderBRes.id,
      userId: userB.id,
      idempotencyKey: `payB_${orderBRes.id}`,
    });
    mockPaymentProvider.confirmIntent(payB.paymentReference);
    const confirmB = await confirmAndProvision({
      orderId: orderBRes.id,
      userId: userB.id,
      idempotencyKey: `confirmB_${orderBRes.id}`,
    });
    expect(confirmB.esimId).toBeTruthy();

    const orderB = await db.order.findUnique({ where: { id: orderBRes.id } });
    expect(orderB!.supplierOfferId).toBe(offer2.id);

    // Different suppliers were selected for the two orders.
    expect(orderA!.supplierOfferId).not.toBe(orderB!.supplierOfferId);

    // Restore supplier 1 health for any later tests.
    await db.supplier.update({
      where: { id: supplier1.id },
      data: { healthStatus: "healthy" },
    });
  }, 60000);

  // -------------------------------------------------------------------------
  // 4. The supplier never determines the tenant's retail price
  // -------------------------------------------------------------------------
  it("The supplier never determines the tenant's retail price", async () => {
    const plan = await makePlan("retailguard");

    const product = await makeProduct({
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      sourcePlanId: plan.id,
    });

    const supplier = await makeSupplier("Supplier-RetailGuard", "mock");
    await db.providerCreditAccount.upsert({
      where: { provider: "mock" },
      update: {},
      create: { provider: "mock", creditLimit: 1_000_000, currency: "USD" },
    });

    // Supplier's ConnectivityOffer retail price is set VERY HIGH (9999).
    // The tenant's retail price is set LOW (1000). The order amount MUST be
    // the tenant's price, not the supplier's.
    await makeConnectivityOffer({
      productId: product.id,
      supplierId: supplier.id,
      wholesalePrice: 500,
      retailPrice: 9999,
    });

    const tenant = await makeTenant("Tenant-RetailGuard");
    const user = await makeUser("user-retailguard");
    await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "admin" });
    const dist = await createDistributionOffer({
      tenantId: tenant.id,
      productId: product.id,
      retailPriceMinor: 1000,
    });
    createdDistOfferIds.push(dist.id);

    const orderRes = await createOrder({
      userId: user.id,
      planId: plan.id,
      tenantId: tenant.id,
      idempotencyKey: `retail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderRes.id);

    expect(orderRes.amountMinor).toBe(1000);
    expect(orderRes.amountMinor).not.toBe(9999);
  }, 60000);

  // -------------------------------------------------------------------------
  // 5. Changing a supplier's retail price after checkout does not change the tenant's frozen retail price
  // -------------------------------------------------------------------------
  it("Changing a supplier's retail price after checkout does not change the tenant's frozen retail price", async () => {
    const plan = await makePlan("frozen");

    const product = await makeProduct({
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      sourcePlanId: plan.id,
    });

    const supplier = await makeSupplier("Supplier-Frozen", "mock");
    await db.providerCreditAccount.upsert({
      where: { provider: "mock" },
      update: {},
      create: { provider: "mock", creditLimit: 1_000_000, currency: "USD" },
    });
    const supplierOffer = await makeConnectivityOffer({
      productId: product.id,
      supplierId: supplier.id,
      wholesalePrice: 500,
      retailPrice: 1500,
    });

    const tenant = await makeTenant("Tenant-Frozen");
    const user = await makeUser("user-frozen");
    await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "admin" });
    const dist = await createDistributionOffer({
      tenantId: tenant.id,
      productId: product.id,
      retailPriceMinor: 1800,
    });
    createdDistOfferIds.push(dist.id);

    const orderRes = await createOrder({
      userId: user.id,
      planId: plan.id,
      tenantId: tenant.id,
      idempotencyKey: `frozen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderRes.id);
    const originalAmount = orderRes.amountMinor;
    expect(originalAmount).toBe(1800);

    // Mutate the supplier's offer prices AFTER checkout.
    await db.connectivityOffer.update({
      where: { id: supplierOffer.id },
      data: { retailPrice: 99999, wholesalePrice: 12345 },
    });

    // Also mutate the DistributionOffer price AFTER checkout — the order
    // amount must STILL be the original frozen amount.
    await db.distributionOffer.update({
      where: { id: dist.id },
      data: { retailPrice: 5555 },
    });

    const refetched = await db.order.findUnique({ where: { id: orderRes.id } });
    expect(refetched!.amount).toBe(originalAmount);
    expect(refetched!.amount).toBe(1800);
  }, 60000);

  // -------------------------------------------------------------------------
  // 6. Changing a supplier's offer does not cause a different supplier to be selected after the order has been committed
  // -------------------------------------------------------------------------
  it("Changing a supplier's offer does not cause a different supplier to be selected after the order has been committed", async () => {
    const plan = await makePlan("committed");

    const product = await makeProduct({
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      sourcePlanId: plan.id,
    });

    const supplier1 = await makeSupplier("Supplier-Committed-1", "mock");
    const supplier2 = await makeSupplier("Supplier-Committed-2", "mock");
    await db.providerCreditAccount.upsert({
      where: { provider: "mock" },
      update: {},
      create: { provider: "mock", creditLimit: 1_000_000, currency: "USD" },
    });

    // Supplier 1 is cheaper → orchestrator picks it.
    const offer1 = await makeConnectivityOffer({
      productId: product.id,
      supplierId: supplier1.id,
      wholesalePrice: 100,
      retailPrice: 500,
    });
    // Supplier 2 is expensive.
    const offer2 = await makeConnectivityOffer({
      productId: product.id,
      supplierId: supplier2.id,
      wholesalePrice: 500,
      retailPrice: 900,
    });

    const tenant = await makeTenant("Tenant-Committed");
    const user = await makeUser("user-committed");
    await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "admin" });
    const dist = await createDistributionOffer({
      tenantId: tenant.id,
      productId: product.id,
      retailPriceMinor: 1500,
    });
    createdDistOfferIds.push(dist.id);

    // Checkout + fulfill — should select supplier 1.
    const { order } = await checkoutAndPay({
      userId: user.id,
      planId: plan.id,
      tenantId: tenant.id,
    });

    const committed = await db.order.findUnique({ where: { id: order.id } });
    expect(committed!.supplierOfferId).toBe(offer1.id);
    expect(committed!.fulfillmentStatus).toBe("success");

    // Now make Supplier 2 drastically cheaper — orchestrator WOULD pick S2
    // for a new order, but the committed order must remain on S1.
    await db.connectivityOffer.update({
      where: { id: offer2.id },
      data: { wholesalePrice: 1, retailPrice: 10 },
    });

    // Verify: re-selecting for this product would now pick S2 — but the
    // committed order still references S1.
    const freshSelection = await selectSupplierForProduct(product.id);
    expect(freshSelection.offerId).toBe(offer2.id);

    const reChecked = await db.order.findUnique({ where: { id: order.id } });
    expect(reChecked!.supplierOfferId).toBe(offer1.id);
    expect(reChecked!.supplierOfferId).not.toBe(freshSelection.offerId);
  }, 60000);

  // -------------------------------------------------------------------------
  // 7. Two independent supplier catalog syncs actually converge onto one ConnectivityProduct
  // -------------------------------------------------------------------------
  it("Two independent supplier catalog syncs actually converge onto one ConnectivityProduct", async () => {
    // Use a unique set of attributes so we don't collide with seeded plans.
    const attrs = {
      name: `Converge Test ${Date.now()}`,
      country: "Atlantis",
      countryCode: "AT",
      region: "Atlantic",
      dataAmountMB: 2048,
      validityDays: 14,
    };

    // Two SEPARATE plans (one per supplier) with the SAME canonical attributes.
    const plan1 = await db.plan.create({
      data: {
        providerId: "supplier1",
        providerPlanId: `conv1_${Date.now()}`,
        name: attrs.name,
        country: attrs.country,
        countryCode: attrs.countryCode,
        region: attrs.region,
        dataAmount: attrs.dataAmountMB,
        dataUnit: "MB",
        validityDays: attrs.validityDays,
        price: 1000,
        wholesalePrice: 700,
        currency: "USD",
        status: "active",
      },
    });
    const plan2 = await db.plan.create({
      data: {
        providerId: "supplier2",
        providerPlanId: `conv2_${Date.now()}`,
        name: attrs.name,
        country: attrs.country,
        countryCode: attrs.countryCode,
        region: attrs.region,
        dataAmount: attrs.dataAmountMB,
        dataUnit: "MB",
        validityDays: attrs.validityDays,
        price: 1100,
        wholesalePrice: 750,
        currency: "USD",
        status: "active",
      },
    });
    // Track for cleanup (via planSnapshot will be cleaned by the order
    // cleanup; but plans themselves aren't cleaned — delete explicitly).
    const createdPlanIds = [plan1.id, plan2.id];

    try {
      // First sync: supplier 1.
      const sync1 = await syncPlanToCatalog({
        planId: plan1.id,
        name: attrs.name,
        country: attrs.country,
        countryCode: attrs.countryCode,
        region: attrs.region,
        dataAmountMB: attrs.dataAmountMB,
        validityDays: attrs.validityDays,
        wholesalePriceMinor: 700,
        currency: "USD",
        supplierProviderKey: "supplier1",
        supplierName: `Converge Supplier 1 ${Date.now()}`,
      });
      createdProductIds.push(sync1.productId);
      createdOfferIds.push(sync1.offerId);
      const offer1 = await db.connectivityOffer.findUnique({ where: { id: sync1.offerId } });
      if (offer1) createdSupplierIds.push(offer1.supplierId);

      expect(sync1.converged).toBe(false); // first time → new product

      // Second sync: supplier 2, same attributes → must converge.
      const sync2 = await syncPlanToCatalog({
        planId: plan2.id,
        name: attrs.name,
        country: attrs.country,
        countryCode: attrs.countryCode,
        region: attrs.region,
        dataAmountMB: attrs.dataAmountMB,
        validityDays: attrs.validityDays,
        wholesalePriceMinor: 750,
        currency: "USD",
        supplierProviderKey: "supplier2",
        supplierName: `Converge Supplier 2 ${Date.now()}`,
      });
      createdOfferIds.push(sync2.offerId);
      const offer2 = await db.connectivityOffer.findUnique({ where: { id: sync2.offerId } });
      if (offer2) createdSupplierIds.push(offer2.supplierId);

      expect(sync2.converged).toBe(true); // converged onto the existing product
      expect(sync2.productId).toBe(sync1.productId); // SAME canonical product

      // There must be TWO ConnectivityOffers under the ONE product.
      const offers = await db.connectivityOffer.findMany({
        where: { productId: sync1.productId },
      });
      expect(offers.length).toBe(2);
      const supplierIds = new Set(offers.map((o) => o.supplierId));
      expect(supplierIds.size).toBe(2);
    } finally {
      await db.plan.deleteMany({ where: { id: { in: createdPlanIds } } }).catch(() => {});
    }
  }, 60000);

  // -------------------------------------------------------------------------
  // 8. A tenant cannot read or modify another tenant's DistributionOffer or Order
  // -------------------------------------------------------------------------
  it("A tenant cannot read or modify another tenant's DistributionOffer or Order", async () => {
    const plan = await makePlan("isolation");

    const product = await makeProduct({
      name: plan.name,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      sourcePlanId: plan.id,
    });

    // Tenant A owns the offer + order.
    const tenantA = await makeTenant("TenantA-Isolation");
    const tenantB = await makeTenant("TenantB-Isolation");
    const userA = await makeUser("userA-isolation");
    const userB = await makeUser("userB-isolation");
    await addTenantUser({ tenantId: tenantA.id, userId: userA.id, role: "admin" });
    await addTenantUser({ tenantId: tenantB.id, userId: userB.id, role: "admin" });

    const distA = await createDistributionOffer({
      tenantId: tenantA.id,
      productId: product.id,
      retailPriceMinor: 1700,
    });
    createdDistOfferIds.push(distA.id);

    // Tenant A creates an order.
    const orderRes = await createOrder({
      userId: userA.id,
      planId: plan.id,
      tenantId: tenantA.id,
      idempotencyKey: `isoA_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    createdOrderIds.push(orderRes.id);

    // Tenant B tries to READ Tenant A's DistributionOffer.
    let threwForOffer = false;
    try {
      await getDistributionOfferForTenant(distA.id, tenantB.id);
    } catch (e) {
      threwForOffer = e instanceof AppError && e.errorClass === "authorization";
    }
    expect(threwForOffer).toBe(true);

    // Tenant B tries to READ Tenant A's Order.
    let threwForOrder = false;
    try {
      await getTenantOrder(orderRes.id, tenantB.id);
    } catch (e) {
      threwForOrder = e instanceof AppError && e.errorClass === "authorization";
    }
    expect(threwForOrder).toBe(true);

    // Tenant B tries to LIST orders — should not include Tenant A's order.
    const tenantBOrders = await getTenantOrders(tenantB.id);
    expect(tenantBOrders.find((o) => o.id === orderRes.id)).toBeUndefined();

    // Tenant B user cannot assert role in Tenant A.
    let threwForRole = false;
    try {
      await assertTenantRole(tenantA.id, userB.id, ["admin", "member"]);
    } catch (e) {
      threwForRole = e instanceof AppError && e.errorClass === "authorization";
    }
    expect(threwForRole).toBe(true);

    // Sanity: Tenant A CAN read their own offer + order.
    const ownOffer = await getDistributionOfferForTenant(distA.id, tenantA.id);
    expect(ownOffer.id).toBe(distA.id);
    const ownOrder = await getTenantOrder(orderRes.id, tenantA.id);
    expect(ownOrder.id).toBe(orderRes.id);
  }, 60000);
});
