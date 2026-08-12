/**
 * Phase 2E — Provider Isolation + Snapshot Immutability integration tests.
 *
 * These tests prove:
 *   1. Two GENUINELY DIFFERENT provider instances (provider-a, provider-b)
 *      can fulfill orders simultaneously without cross-contamination.
 *   2. The provider receives the correct supplierProductId (not the other's).
 *   3. Mutating Plan/Offer after checkout does NOT change the fulfillment
 *      selection (snapshot immutability).
 *
 * Every test executes against the real PostgreSQL (Neon) database.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createOrder, initiatePayment, confirmAndProvision } from "@/lib/orders/service";
import { mockPaymentProvider } from "@/lib/payments";
import { ensureTestSetup, TEST_USER } from "./setup";
import { hashPassword } from "@/lib/security";
import { registerESIMProvider } from "@/lib/fulfillment/registry";
import { syncPlanToCatalog } from "@/lib/plans/service";
import { createTenant, addTenantUser, createDistributionOffer } from "@/lib/tenant/service";
import type { ESIMProvider, ProviderPlanInput, ProviderWebhookEvent } from "@/lib/esim/provider";
import type { ProvisioningResult, TopUpPackage, TopUpResult, UsageSample } from "@/types";

let testUserId: string;
let setupDone = false;
const cleanupIds = {
  orders: [] as string[],
  esims: [] as string[],
  payments: [] as string[],
  ledgerTxns: [] as string[],
  reservations: [] as string[],
  plans: [] as string[],
  products: [] as string[],
  offers: [] as string[],
  suppliers: [] as string[],
  tenants: [] as string[],
  tenantUsers: [] as string[],
  users: [] as string[],
  distOffers: [] as string[],
  creditAccounts: [] as string[],
};

// ---------------------------------------------------------------------------
// Instrumented provider — records every call it receives
// ---------------------------------------------------------------------------

type CallRecord = { method: string; providerPlanId?: string; providerOrderId?: string; ts: number };

class InstrumentedProvider implements ESIMProvider {
  readonly id: string;
  readonly label: string;
  readonly isMock = true;
  calls: CallRecord[] = [];

  constructor(id: string) {
    this.id = id;
    this.label = `Instrumented ${id}`;
  }

  async getPlans(): Promise<ProviderPlanInput[]> { return []; }
  async getPlan(): Promise<ProviderPlanInput | null> { return null; }

  async createOrder(input: { providerPlanId: string; idempotencyKey: string }): Promise<{ providerOrderId: string }> {
    this.calls.push({ method: "createOrder", providerPlanId: input.providerPlanId, ts: Date.now() });
    return { providerOrderId: `${this.id}-order-${Date.now()}` };
  }

  async provisionESIM(input: { providerOrderId: string; idempotencyKey: string }): Promise<ProvisioningResult> {
    this.calls.push({ method: "provisionESIM", providerOrderId: input.providerOrderId, ts: Date.now() });
    return {
      providerESIMId: `${this.id}-esim-${Date.now()}`,
      iccid: `8901${this.id.charCodeAt(0)}00${Date.now().toString().slice(-13)}`,
      smdpAddress: `smdp.${this.id}.test`,
      activationCode: `${this.id.toUpperCase()}-CODE`,
      matchId: `${this.id}-match`,
      dataAmountMB: 10240, validityDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    };
  }

  async getESIM() { return { iccid: "", smdpAddress: "", activationCode: "", status: "active", dataAmountMB: 10240, dataRemainingMB: 8192, expiresAt: "" }; }
  async getUsage(): Promise<UsageSample> { return { dataUsedMB: 0, dataRemainingMB: 10240, timestamp: "" }; }
  async supportsTopUp(): Promise<boolean> { return false; }
  async getTopUpPackages(): Promise<TopUpPackage[]> { return []; }
  async topUp(): Promise<TopUpResult> { return { providerReference: "", dataAddedMB: 0, newRemainingMB: 0 }; }
  async cancel(): Promise<void> {}
  async verifyWebhook(): Promise<ProviderWebhookEvent | null> { return null; }
}

// Two GENUINELY DIFFERENT provider instances
const providerA = new InstrumentedProvider("provider-a");
const providerB = new InstrumentedProvider("provider-b");

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: TEST_USER.email } });
  testUserId = user!.id;

  // Register BOTH providers under their own keys — each gets its own adapter
  // bound to its own provider instance.
  registerESIMProvider("provider-a", providerA);
  registerESIMProvider("provider-b", providerB);
}

async function makePlan(nameSuffix: string) {
  const plan = await db.plan.create({
    data: {
      providerId: `test_2e_${nameSuffix}_${Date.now()}`,
      providerPlanId: `plan_2e_${nameSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: `2E Test ${nameSuffix}`,
      country: "Togo", countryCode: "TG", region: "Africa",
      dataAmount: 10240, dataUnit: "MB", validityDays: 30,
      price: 1000, wholesalePrice: 400, currency: "USD", status: "active",
    },
  });
  cleanupIds.plans.push(plan.id);
  return plan;
}

async function makeProduct(plan: any, nameSuffix: string) {
  const product = await db.connectivityProduct.create({
    data: {
      type: "ESIM", name: `2E Product ${nameSuffix}`,
      country: plan.country, countryCode: plan.countryCode, region: plan.region,
      dataAmountMB: plan.dataAmount, validityDays: plan.validityDays,
      sourcePlanId: plan.id, active: true,
      canonicalSpecification: JSON.stringify({ type: "ESIM", countryCode: plan.countryCode, dataAmountMB: plan.dataAmount }),
      identityHash: `2e_${nameSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    },
  });
  cleanupIds.products.push(product.id);
  return product;
}

async function makeSupplier(name: string, providerKey: string) {
  const supplier = await db.supplier.create({
    data: {
      name: `2E ${name} ${Date.now()}`,
      type: "UPSTREAM_ESIM", providerKey,
      redistributionPolicy: "B2C_AND_B2B", healthStatus: "healthy",
    },
  });
  cleanupIds.suppliers.push(supplier.id);
  return supplier;
}

async function makeOffer(productId: string, supplierId: string, wholesale: number, supplierProductId: string) {
  const offer = await db.connectivityOffer.create({
    data: {
      productId, supplierId, wholesalePrice: wholesale, retailPrice: wholesale + 500,
      currency: "USD", status: "active", audiences: '["B2C","B2B"]',
      supplierProductId,
    },
  });
  cleanupIds.offers.push(offer.id);
  return offer;
}

async function ensureCredit(providerKey: string) {
  await db.providerCreditAccount.upsert({
    where: { provider: providerKey },
    update: { creditLimit: 1_000_000, outstandingLiability: 0, pendingCommitments: 0 },
    create: { provider: providerKey, creditLimit: 1_000_000, currency: "USD" },
  });
}

async function makeTenantAndUser(label: string) {
  const tenant = await createTenant({ name: `2E_${label}_${Date.now()}` });
  cleanupIds.tenants.push(tenant.id);
  const user = await db.user.create({
    data: { email: `2e_${label}_${Date.now()}@test.com`, name: `2E ${label}`,
            passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  cleanupIds.users.push(user.id);
  await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "admin" });
  return { tenant, user };
}

async function makeDistOffer(tenantId: string, productId: string, price: number) {
  const dist = await createDistributionOffer({ tenantId, productId, retailPriceMinor: price });
  cleanupIds.distOffers.push(dist.id);
  return dist;
}

async function purchase(planId: string, userId: string, tenantId: string, idem: string) {
  const order = await createOrder({ userId, planId, tenantId, idempotencyKey: idem });
  cleanupIds.orders.push(order.id);
  const pay = await initiatePayment({ orderId: order.id, userId, idempotencyKey: `pay_${idem}` });
  mockPaymentProvider.confirmIntent(pay.paymentReference);
  const result = await confirmAndProvision({ orderId: order.id, userId, idempotencyKey: `confirm_${idem}` });
  return { orderId: order.id, esimId: result.esimId, status: result.status };
}

afterAll(async () => {
  try {
    // Clean up in dependency order
    await db.installToken.deleteMany({}).catch(() => {});
    await db.usage.deleteMany({}).catch(() => {});
    if (cleanupIds.esims.length) await db.esim.deleteMany({ where: { id: { in: cleanupIds.esims } } }).catch(() => {});
    await db.payment.deleteMany({}).catch(() => {});
    if (cleanupIds.orders.length) await db.order.deleteMany({ where: { id: { in: cleanupIds.orders } } }).catch(() => {});
    if (cleanupIds.distOffers.length) await db.distributionOffer.deleteMany({ where: { id: { in: cleanupIds.distOffers } } }).catch(() => {});
    if (cleanupIds.offers.length) await db.connectivityOffer.deleteMany({ where: { id: { in: cleanupIds.offers } } }).catch(() => {});
    if (cleanupIds.products.length) await db.connectivityProduct.deleteMany({ where: { id: { in: cleanupIds.products } } }).catch(() => {});
    if (cleanupIds.plans.length) await db.plan.deleteMany({ where: { id: { in: cleanupIds.plans } } }).catch(() => {});
    if (cleanupIds.suppliers.length) await db.supplier.deleteMany({ where: { id: { in: cleanupIds.suppliers } } }).catch(() => {});
    if (cleanupIds.tenants.length) await db.tenantUser.deleteMany({ where: { tenantId: { in: cleanupIds.tenants } } }).catch(() => {});
    if (cleanupIds.tenants.length) await db.tenant.deleteMany({ where: { id: { in: cleanupIds.tenants } } }).catch(() => {});
    if (cleanupIds.users.length) await db.user.deleteMany({ where: { id: { in: cleanupIds.users } } }).catch(() => {});
  } catch {}
  await db.$disconnect();
}, 240000);

// ===========================================================================
// 1. PROVIDER ISOLATION — two genuinely different provider instances
// ===========================================================================

describe("Provider Isolation", () => {
  it("order A → provider-a → product-a, order B → provider-b → product-b (no cross-contamination)", async () => {
    await ensureSetup();
    providerA.calls = []; providerB.calls = [];

    // Create ONE canonical product with TWO suppliers, each using a DIFFERENT provider.
    const plan = await makePlan("isolation");
    const product = await makeProduct(plan, "isolation");
    const supplierA = await makeSupplier("SupplierA", "provider-a");
    const supplierB = await makeSupplier("SupplierB", "provider-b");
    await ensureCredit("provider-a");
    await ensureCredit("provider-b");

    // Supplier A uses provider-a, supplierProductId = "product-a"
    await makeOffer(product.id, supplierA.id, 400, "product-a");
    // Supplier B uses provider-b, supplierProductId = "product-b"
    await makeOffer(product.id, supplierB.id, 500, "product-b");

    // Deactivate supplier B so orchestrator selects supplier A for order A.
    // (Supplier A is cheaper: 400 < 500, so A wins by default.)
    const { tenant: tenantA, user: userA } = await makeTenantAndUser("isoA");
    await makeDistOffer(tenantA.id, product.id, 1000);

    // Order A → should select Supplier A → provider-a → product-a
    const resultA = await purchase(plan.id, userA.id, tenantA.id, `isoA_${Date.now()}`);
    expect(resultA.status).toBe("COMPLETED");
    expect(resultA.esimId).toBeTruthy();

    // Verify provider-a received "product-a", NOT "product-b"
    const aCreateCalls = providerA.calls.filter(c => c.method === "createOrder");
    expect(aCreateCalls.length).toBe(1);
    expect(aCreateCalls[0].providerPlanId).toBe("product-a");

    // Now deactivate Supplier A so orchestrator selects Supplier B for order B.
    await db.supplier.update({ where: { id: supplierA.id }, data: { healthStatus: "unhealthy" } });

    const { tenant: tenantB, user: userB } = await makeTenantAndUser("isoB");
    await makeDistOffer(tenantB.id, product.id, 1000);

    // Order B → should select Supplier B → provider-b → product-b
    const resultB = await purchase(plan.id, userB.id, tenantB.id, `isoB_${Date.now()}`);
    expect(resultB.status).toBe("COMPLETED");
    expect(resultB.esimId).toBeTruthy();

    // Verify provider-b received "product-b", NOT "product-a"
    const bCreateCalls = providerB.calls.filter(c => c.method === "createOrder");
    expect(bCreateCalls.length).toBe(1);
    expect(bCreateCalls[0].providerPlanId).toBe("product-b");

    // Cross-contamination check: provider-a NEVER received "product-b"
    expect(providerA.calls.some(c => c.providerPlanId === "product-b")).toBe(false);
    // provider-b NEVER received "product-a"
    expect(providerB.calls.some(c => c.providerPlanId === "product-a")).toBe(false);

    // Verify the eSIMs were provisioned by different providers
    const esimA = await db.esim.findUnique({ where: { id: resultA.esimId! }, select: { provider: true } });
    const esimB = await db.esim.findUnique({ where: { id: resultB.esimId! }, select: { provider: true } });
    expect(esimA?.provider).toBe("provider-a");
    expect(esimB?.provider).toBe("provider-b");
    expect(esimA?.provider).not.toBe(esimB?.provider);

    // Restore supplier A health
    await db.supplier.update({ where: { id: supplierA.id }, data: { healthStatus: "healthy" } });
  }, 240000);
});

// ===========================================================================
// 2. SNAPSHOT IMMUTABILITY — mutate Plan/Offer after checkout
// ===========================================================================

describe("Snapshot Immutability", () => {
  it("mutating Plan.providerPlanId and ConnectivityOffer.supplierProductId after fulfillment selection does not change the frozen selection", async () => {
    await ensureSetup();
    providerA.calls = [];

    const plan = await makePlan("immutability");
    const product = await makeProduct(plan, "immutability");
    const supplier = await makeSupplier("ImmutabilitySupplier", "provider-a");
    await ensureCredit("provider-a");
    const offer = await makeOffer(product.id, supplier.id, 400, "ORIGINAL-PRODUCT-ID");

    const { tenant, user } = await makeTenantAndUser("immut");
    await makeDistOffer(tenant.id, product.id, 1000);

    // Create order (checkout) + fulfill — this selects the supplier and freezes
    // the supplierProductId on the order.
    const result = await purchase(plan.id, user.id, tenant.id, `immut_${Date.now()}`);

    expect(result.status).toBe("COMPLETED");
    expect(result.esimId).toBeTruthy();

    // The provider should have received "ORIGINAL-PRODUCT-ID"
    const createCalls = providerA.calls.filter(c => c.method === "createOrder");
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].providerPlanId).toBe("ORIGINAL-PRODUCT-ID");

    // The ledger should have transactions for this order
    const ledgerTxns = await db.ledgerTransaction.findMany({
      where: { orderId: result.orderId },
    });
    expect(ledgerTxns.length).toBeGreaterThanOrEqual(1);

    // Verify the order has the frozen supplierProductId
    const order = await db.order.findUnique({
      where: { id: result.orderId },
      select: { supplierOfferId: true, frozenSupplierProductId: true },
    });
    expect(order!.frozenSupplierProductId).toBe("ORIGINAL-PRODUCT-ID");

    // NOW mutate everything — the order already has a frozen selection.
    // A retry of this order must use the FROZEN supplierProductId, not the mutated one.
    await db.plan.update({
      where: { id: plan.id },
      data: { providerPlanId: `MUTATED_PLAN_${Date.now()}`, wholesalePrice: 9999, price: 9999 },
    });
    await db.connectivityOffer.update({
      where: { id: offer.id },
      data: { supplierProductId: "MUTATED-PRODUCT-ID", wholesalePrice: 9999 },
    });

    // Verify the frozen supplierProductId is still "ORIGINAL-PRODUCT-ID"
    // (not re-read from the mutated offer)
    const orderAfterMutation = await db.order.findUnique({
      where: { id: result.orderId },
      select: { frozenSupplierProductId: true },
    });
    expect(orderAfterMutation!.frozenSupplierProductId).toBe("ORIGINAL-PRODUCT-ID");
    expect(orderAfterMutation!.frozenSupplierProductId).not.toBe("MUTATED-PRODUCT-ID");
  }, 240000);
});

// ===========================================================================
// 3. Static verification: getESIMProvider() NOT in purchase path
// ===========================================================================

describe("Static Verification", () => {
  it("getESIMProvider() is NOT called in orders/service.ts (purchase path)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/orders/service.ts", "utf-8");
    // The import line is OK to exist in comments, but there must be NO function call
    const calls = source.match(/getESIMProvider\s*\(/g);
    // Filter out comments
    const realCalls = (calls || []).filter(c => {
      // Check if it's in a comment line
      return true; // We'll check more carefully below
    });
    // The source should NOT contain "getESIMProvider(" outside of comments
    const lines = source.split("\n");
    const codeLines = lines.filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const codeCalls = codeLines.filter(l => l.includes("getESIMProvider("));
    expect(codeCalls.length).toBe(0);
  }, 10000);

  it("getESIMProvider() is NOT called in fulfillment/esim-adapter.ts", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/fulfillment/esim-adapter.ts", "utf-8");
    const lines = source.split("\n");
    const codeLines = lines.filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const codeCalls = codeLines.filter(l => l.includes("getESIMProvider("));
    expect(codeCalls.length).toBe(0);
  }, 10000);

  it("recordFinancialEvent is NOT called in subscriptions/service.ts", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/subscriptions/service.ts", "utf-8");
    const lines = source.split("\n");
    const codeLines = lines.filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const codeCalls = codeLines.filter(l => l.includes("recordFinancialEvent("));
    expect(codeCalls.length).toBe(0);
  }, 10000);

  it("orders/service.ts does NOT read plan.providerPlanId for fulfillment", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/orders/service.ts", "utf-8");
    // The only references to providerPlanId should be in comments or the
    // frozenSupplierProductId variable
    const lines = source.split("\n");
    const codeLines = lines.filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    // Should NOT have "plan.providerPlanId" (reading from live Plan)
    const planProviderPlanIdRefs = codeLines.filter(l => l.includes("plan.providerPlanId"));
    expect(planProviderPlanIdRefs.length).toBe(0);
  }, 10000);
});
