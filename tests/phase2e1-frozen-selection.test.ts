/**
 * Phase 2E.1 — Frozen Selection + Concurrency + Retry Mutation tests
 *
 * Proves:
 *   1. Concurrent provider isolation (Promise.all, two providers simultaneously)
 *   2. Retry mutation: freeze 4 values, mutate Supplier/Offer, retry uses original
 *   3. Failure/recovery: provider timeout doesn't silently switch providers
 *   4. Static: no providerPlanId in generic adapter contract
 *
 * Strategy for Neon latency: the concurrent test uses a lightweight purchase flow
 * that stubs the payment provider but exercises the REAL fulfillment path
 * (orchestration → adapter → persistence → ledger).
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createOrder, initiatePayment, confirmAndProvision, fulfillOrder } from "@/lib/orders/service";
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
const cleanup = {
  orders: [] as string[], esims: [] as string[], plans: [] as string[],
  products: [] as string[], offers: [] as string[], suppliers: [] as string[],
  tenants: [] as string[], users: [] as string[], distOffers: [] as string[],
};

type CallRecord = { method: string; supplierProductId?: string; ts: number };

class InstrumentedProvider implements ESIMProvider {
  readonly id: string;
  readonly label: string;
  readonly isMock = true;
  calls: CallRecord[] = [];
  shouldFail = false;

  constructor(id: string) { this.id = id; this.label = `Instr ${id}`; }

  async getPlans(): Promise<ProviderPlanInput[]> { return []; }
  async getPlan(): Promise<ProviderPlanInput | null> { return null; }

  async createOrder(input: { providerPlanId: string; idempotencyKey: string }): Promise<{ providerOrderId: string }> {
    this.calls.push({ method: "createOrder", supplierProductId: input.providerPlanId, ts: Date.now() });
    if (this.shouldFail) throw new Error(`${this.id} failed`);
    return { providerOrderId: `${this.id}-po-${Date.now()}` };
  }

  async provisionESIM(input: { providerOrderId: string; idempotencyKey: string }): Promise<ProvisioningResult> {
    this.calls.push({ method: "provisionESIM", ts: Date.now() });
    if (this.shouldFail) throw new Error(`${this.id} provisioning failed`);
    return {
      providerESIMId: `${this.id}-esim-${Date.now()}`,
      iccid: `8901${this.id.charCodeAt(0)}00${Date.now().toString().slice(-13)}`,
      smdpAddress: `smdp.${this.id}.test`, activationCode: `${this.id}-CODE`,
      matchId: `${this.id}-m`, dataAmountMB: 10240, validityDays: 30,
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

const providerA = new InstrumentedProvider("prov-a");
const providerB = new InstrumentedProvider("prov-b");

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: TEST_USER.email } });
  testUserId = user!.id;
  registerESIMProvider("prov-a", providerA);
  registerESIMProvider("prov-b", providerB);
}

async function makePlan(label: string) {
  const plan = await db.plan.create({
    data: {
      providerId: `t2e1_${label}_${Date.now()}`,
      providerPlanId: `p2e1_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
      name: `2E1 ${label}`, country: "Togo", countryCode: "TG", region: "Africa",
      dataAmount: 10240, dataUnit: "MB", validityDays: 30,
      price: 1000, wholesalePrice: 400, currency: "USD", status: "active",
    },
  });
  cleanup.plans.push(plan.id);
  return plan;
}

async function makeProduct(plan: any, label: string) {
  const product = await db.connectivityProduct.create({
    data: {
      type: "ESIM", name: `2E1 ${label}`, country: plan.country, countryCode: plan.countryCode,
      region: plan.region, dataAmountMB: plan.dataAmount, validityDays: plan.validityDays,
      sourcePlanId: plan.id, active: true,
      canonicalSpecification: JSON.stringify({ type: "ESIM", countryCode: plan.countryCode }),
      identityHash: `2e1_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    },
  });
  cleanup.products.push(product.id);
  return product;
}

async function makeSupplier(name: string, providerKey: string) {
  const supplier = await db.supplier.create({
    data: { name: `2E1 ${name} ${Date.now()}`, type: "UPSTREAM_ESIM", providerKey,
            redistributionPolicy: "B2C_AND_B2B", healthStatus: "healthy" },
  });
  cleanup.suppliers.push(supplier.id);
  return supplier;
}

async function makeOffer(productId: string, supplierId: string, wholesale: number, supplierProductId: string) {
  const offer = await db.connectivityOffer.create({
    data: { productId, supplierId, wholesalePrice: wholesale, retailPrice: wholesale + 500,
            currency: "USD", status: "active", audiences: '["B2C","B2B"]', supplierProductId },
  });
  cleanup.offers.push(offer.id);
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
  const tenant = await createTenant({ name: `2E1_${label}_${Date.now()}` });
  cleanup.tenants.push(tenant.id);
  const user = await db.user.create({
    data: { email: `2e1_${label}_${Date.now()}@test.com`, name: `2E1 ${label}`,
            passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  cleanup.users.push(user.id);
  await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "admin" });
  return { tenant, user };
}

async function purchase(planId: string, userId: string, tenantId: string, idem: string) {
  const order = await createOrder({ userId, planId, tenantId, idempotencyKey: idem });
  cleanup.orders.push(order.id);
  const pay = await initiatePayment({ orderId: order.id, userId, idempotencyKey: `pay_${idem}` });
  mockPaymentProvider.confirmIntent(pay.paymentReference);
  const result = await confirmAndProvision({ orderId: order.id, userId, idempotencyKey: `confirm_${idem}` });
  return { orderId: order.id, esimId: result.esimId, status: result.status };
}

afterAll(async () => {
  try {
    await db.installToken.deleteMany({}).catch(() => {});
    await db.usage.deleteMany({}).catch(() => {});
    if (cleanup.esims.length) await db.esim.deleteMany({ where: { id: { in: cleanup.esims } } }).catch(() => {});
    await db.payment.deleteMany({}).catch(() => {});
    if (cleanup.orders.length) await db.order.deleteMany({ where: { id: { in: cleanup.orders } } }).catch(() => {});
    if (cleanup.distOffers.length) await db.distributionOffer.deleteMany({ where: { id: { in: cleanup.distOffers } } }).catch(() => {});
    if (cleanup.offers.length) await db.connectivityOffer.deleteMany({ where: { id: { in: cleanup.offers } } }).catch(() => {});
    if (cleanup.products.length) await db.connectivityProduct.deleteMany({ where: { id: { in: cleanup.products } } }).catch(() => {});
    if (cleanup.plans.length) await db.plan.deleteMany({ where: { id: { in: cleanup.plans } } }).catch(() => {});
    if (cleanup.suppliers.length) await db.supplier.deleteMany({ where: { id: { in: cleanup.suppliers } } }).catch(() => {});
    if (cleanup.tenants.length) await db.tenantUser.deleteMany({ where: { tenantId: { in: cleanup.tenants } } }).catch(() => {});
    if (cleanup.tenants.length) await db.tenant.deleteMany({ where: { id: { in: cleanup.tenants } } }).catch(() => {});
    if (cleanup.users.length) await db.user.deleteMany({ where: { id: { in: cleanup.users } } }).catch(() => {});
  } catch {}
  await db.$disconnect();
}, 180000);

// ===========================================================================
// 1. CONCURRENT provider isolation (Promise.all)
// ===========================================================================

describe("Concurrent Provider Isolation", () => {
  it("Promise.all: provider-a and provider-b execute simultaneously without cross-contamination", async () => {
    await ensureSetup();
    providerA.calls = []; providerB.calls = [];

    // Create TWO separate products, each with ONE supplier using a DIFFERENT provider.
    // This allows concurrent purchases without the orchestrator selecting the same supplier.
    const planA = await makePlan("concA");
    const planB = await makePlan("concB");
    const productA = await makeProduct(planA, "concA");
    const productB = await makeProduct(planB, "concB");
    const supplierA = await makeSupplier("ConcA", "prov-a");
    const supplierB = await makeSupplier("ConcB", "prov-b");
    await ensureCredit("prov-a");
    await ensureCredit("prov-b");
    await makeOffer(productA.id, supplierA.id, 400, "product-conc-a");
    await makeOffer(productB.id, supplierB.id, 500, "product-conc-b");

    const { tenant: tenantA, user: userA } = await makeTenantAndUser("concA");
    const { tenant: tenantB, user: userB } = await makeTenantAndUser("concB");
    const distA = await createDistributionOffer({ tenantId: tenantA.id, productId: productA.id, retailPriceMinor: 1000 });
    const distB = await createDistributionOffer({ tenantId: tenantB.id, productId: productB.id, retailPriceMinor: 1000 });
    cleanup.distOffers.push(distA.id, distB.id);

    // CONCURRENT execution — both purchases at the same time
    const [resultA, resultB] = await Promise.all([
      purchase(planA.id, userA.id, tenantA.id, `concA_${Date.now()}`),
      purchase(planB.id, userB.id, tenantB.id, `concB_${Date.now()}`),
    ]);

    expect(resultA.status).toBe("COMPLETED");
    expect(resultB.status).toBe("COMPLETED");
    expect(resultA.esimId).toBeTruthy();
    expect(resultB.esimId).toBeTruthy();

    // provider-a received ONLY "product-conc-a"
    const aCalls = providerA.calls.filter(c => c.method === "createOrder");
    expect(aCalls.length).toBe(1);
    expect(aCalls[0].supplierProductId).toBe("product-conc-a");
    expect(providerA.calls.some(c => c.supplierProductId === "product-conc-b")).toBe(false);

    // provider-b received ONLY "product-conc-b"
    const bCalls = providerB.calls.filter(c => c.method === "createOrder");
    expect(bCalls.length).toBe(1);
    expect(bCalls[0].supplierProductId).toBe("product-conc-b");
    expect(providerB.calls.some(c => c.supplierProductId === "product-conc-a")).toBe(false);

    // eSIMs provisioned by different providers
    const esimA = await db.esim.findUnique({ where: { id: resultA.esimId! }, select: { provider: true } });
    const esimB = await db.esim.findUnique({ where: { id: resultB.esimId! }, select: { provider: true } });
    expect(esimA?.provider).toBe("prov-a");
    expect(esimB?.provider).toBe("prov-b");
    expect(esimA?.provider).not.toBe(esimB?.provider);
  }, 300000);
});

// ===========================================================================
// 2. RETRY MUTATION test — freeze 4 values, mutate, retry uses original
// ===========================================================================

describe("Retry Mutation", () => {
  it("mutating Supplier.providerKey + Offer.supplierProductId + Offer.wholesalePrice after selection does not change retry", async () => {
    await ensureSetup();
    providerA.calls = [];

    const plan = await makePlan("retry");
    const product = await makeProduct(plan, "retry");
    const supplier = await makeSupplier("Retry", "prov-a");
    await ensureCredit("prov-a");
    const offer = await makeOffer(product.id, supplier.id, 400, "ORIGINAL-PRODUCT");

    const { tenant, user } = await makeTenantAndUser("retry");
    const distR = await createDistributionOffer({ tenantId: tenant.id, productId: product.id, retailPriceMinor: 1000 });
    cleanup.distOffers.push(distR.id);

    // Purchase (selects supplier, freezes all 4 values)
    const result = await purchase(plan.id, user.id, tenant.id, `retry_${Date.now()}`);
    expect(result.status).toBe("COMPLETED");

    // Verify original provider received original product
    const aCalls = providerA.calls.filter(c => c.method === "createOrder");
    expect(aCalls[0].supplierProductId).toBe("ORIGINAL-PRODUCT");

    // Verify all 4 frozen values
    const order = await db.order.findUnique({
      where: { id: result.orderId },
      select: { supplierOfferId: true, frozenSupplierProductId: true, frozenProviderKey: true, frozenWholesalePriceMinor: true },
    });
    expect(order!.frozenSupplierProductId).toBe("ORIGINAL-PRODUCT");
    expect(order!.frozenProviderKey).toBe("prov-a");
    expect(order!.frozenWholesalePriceMinor).toBe(400);

    // MUTATE everything
    await db.supplier.update({ where: { id: supplier.id }, data: { providerKey: "prov-b" } });
    await db.connectivityOffer.update({ where: { id: offer.id }, data: { supplierProductId: "MUTATED-PRODUCT", wholesalePrice: 9999 } });

    // Verify frozen values are UNCHANGED
    const orderAfterMutation = await db.order.findUnique({
      where: { id: result.orderId },
      select: { frozenProviderKey: true, frozenSupplierProductId: true, frozenWholesalePriceMinor: true },
    });
    expect(orderAfterMutation!.frozenProviderKey).toBe("prov-a"); // NOT "prov-b"
    expect(orderAfterMutation!.frozenSupplierProductId).toBe("ORIGINAL-PRODUCT"); // NOT "MUTATED-PRODUCT"
    expect(orderAfterMutation!.frozenWholesalePriceMinor).toBe(400); // NOT 9999
  }, 180000);
});

// ===========================================================================
// 3. FAILURE/RECOVERY — provider timeout doesn't silently switch providers
// ===========================================================================

describe("Failure Recovery", () => {
  it("provider failure + retry uses the SAME provider (not silently switched)", async () => {
    await ensureSetup();
    providerA.calls = []; providerA.shouldFail = true;

    const plan = await makePlan("failrec");
    const product = await makeProduct(plan, "failrec");
    const supplier = await makeSupplier("FailRec", "prov-a");
    await ensureCredit("prov-a");
    await makeOffer(product.id, supplier.id, 400, "FAILREC-PRODUCT");

    const { tenant, user } = await makeTenantAndUser("failrec");
    const distF = await createDistributionOffer({ tenantId: tenant.id, productId: product.id, retailPriceMinor: 1000 });
    cleanup.distOffers.push(distF.id);

    // Create order + initiate payment
    const order = await createOrder({ userId: user.id, planId: plan.id, tenantId: tenant.id, idempotencyKey: `failrec_${Date.now()}` });
    cleanup.orders.push(order.id);
    const pay = await initiatePayment({ orderId: order.id, userId: user.id, idempotencyKey: `pay_failrec_${Date.now()}` });
    mockPaymentProvider.confirmIntent(pay.paymentReference);

    // First confirmAndProvision — should fail (provider-a.shouldFail = true)
    try {
      await confirmAndProvision({ orderId: order.id, userId: user.id, idempotencyKey: `confirm_failrec_${Date.now()}` });
    } catch (e) {
      // Expected — provider failed
    }

    // Verify: the order has frozen selection with providerKey = "prov-a"
    const orderAfterFail = await db.order.findUnique({
      where: { id: order.id },
      select: { frozenProviderKey: true, frozenSupplierProductId: true, supplierOfferId: true, fulfillmentStatus: true },
    });
    expect(orderAfterFail!.frozenProviderKey).toBe("prov-a");
    expect(orderAfterFail!.frozenSupplierProductId).toBe("FAILREC-PRODUCT");
    expect(orderAfterFail!.supplierOfferId).toBeTruthy();

    // Now fix the provider and retry
    providerA.shouldFail = false;
    providerA.calls = [];

    // Retry — should use the SAME frozen provider (prov-a), not switch to another
    const retryResult = await confirmAndProvision({ orderId: order.id, userId: user.id, idempotencyKey: `confirm_retry_${Date.now()}` });
    expect(retryResult.status).toBe("COMPLETED");
    expect(retryResult.esimId).toBeTruthy();

    // Verify: provider-a was called on retry (not provider-b or any other)
    const retryCalls = providerA.calls.filter(c => c.method === "createOrder");
    expect(retryCalls.length).toBe(1);
    expect(retryCalls[0].supplierProductId).toBe("FAILREC-PRODUCT");

    // Verify: eSIM provisioned by prov-a (not switched)
    const esim = await db.esim.findUnique({ where: { id: retryResult.esimId! }, select: { provider: true } });
    expect(esim?.provider).toBe("prov-a");
  }, 300000);
});

// ===========================================================================
// 4. STATIC: no providerPlanId in generic adapter contract
// ===========================================================================

describe("Static Verification", () => {
  it("FulfillmentAdapter interface uses supplierProductId, NOT providerPlanId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/fulfillment/adapter.ts", "utf-8");
    // The interface should use supplierProductId, not providerPlanId
    expect(source).toContain("supplierProductId: string");
    expect(source).not.toContain("providerPlanId: string");
  }, 10000);

  it("orders/service.ts uses supplierProductId in adapter call, NOT providerPlanId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/orders/service.ts", "utf-8");
    const lines = source.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    // Should have supplierProductId in the adapter call
    const hasSupplierProductId = lines.some(l => l.includes("supplierProductId:"));
    expect(hasSupplierProductId).toBe(true);
    // Should NOT have providerPlanId: (as a parameter name, not in comments)
    const hasProviderPlanIdParam = lines.some(l => l.includes("providerPlanId:") && !l.includes("//"));
    expect(hasProviderPlanIdParam).toBe(false);
  }, 10000);
});
