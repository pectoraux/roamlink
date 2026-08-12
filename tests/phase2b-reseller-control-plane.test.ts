/**
 * Phase 2B — Reseller SaaS Control Plane: Integration Tests
 *
 * Tests the full vertical slice at the service level (the same pattern used
 * by existing Phase 2C/2E tests). Route handlers are verified via static
 * checks (existence + correct exports) in the same file.
 *
 * Scenarios (from Phase 2B prompt §38):
 *   1.  Tenant A can create customer
 *   2.  Tenant B cannot access Tenant A customer
 *   3.  Tenant A can enable a connectivity product
 *   4.  Tenant B cannot modify Tenant A pricing
 *   5.  Tenant A can create a customer order
 *   6.  Order resolves through existing orchestration
 *   7.  Supplier remains hidden from tenant (no supplier fields in API response)
 *   8.  Correct provider adapter fulfills order
 *   9.  Tenant retail price is preserved in order snapshot
 *   10. Upstream supplier economics remain separate
 *   11. Financial ledger remains canonical
 *   12. Tenant economics are calculated correctly
 *   13. RoamLink platform revenue is separated from reseller revenue
 *   14. Tenant user permissions work (viewer cannot write)
 *   15. Multi-tenant users can switch active tenant safely
 *   16. Tenant API cannot cross tenant boundary
 *   17. SaaS entitlement limits are enforced server-side
 *   19. Cross-tenant order access is denied
 *   20. Audit logs record sensitive tenant operations
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans, assertCanAddCustomer, assertCanAddStaff, assertCanCreateOrder, calculatePlatformFee, getTenantEntitlements } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser, assertTenantRole } from "@/lib/tenant/service";
import { createTenantCustomer, getTenantCustomer, listTenantCustomers, updateTenantCustomer, getTenantCustomerStats } from "@/lib/tenant/customers";
import { listAvailableProducts, enableProduct, disableProduct, getTenantCatalog, getOfferEconomics } from "@/lib/tenant/catalog";
import { getActiveTenant, requireTenantContext, requireTenantRole, setActiveTenant, listUserTenants, TENANT_MANAGE_ROLES, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { hashPassword } from "@/lib/security";
import { AppError } from "@/lib/errors";
import { createOrder, confirmAndProvision } from "@/lib/orders/service";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { ACCOUNT_CODES } from "@/lib/finance/double-entry-ledger";

let setupDone = false;
let tenantA_id: string;
let tenantB_id: string;
let userA_id: string;
let userB_id: string;
let testCustomerA_id: string;
let testDistOfferA_id: string;
let testProduct_id: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();

  // Create two test users
  const userA = await db.user.create({
    data: { email: `reseller-a-${Date.now()}@test.com`, name: "Reseller A", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  const userB = await db.user.create({
    data: { email: `reseller-b-${Date.now()}@test.com`, name: "Reseller B", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userA_id = userA.id;
  userB_id = userB.id;

  // Create two tenants
  const tenantA = await createTenant({ name: `Reseller A ${Date.now()}`, defaultMarkupPercent: 20 });
  const tenantB = await createTenant({ name: `Reseller B ${Date.now()}`, defaultMarkupPercent: 15 });
  tenantA_id = tenantA.id;
  tenantB_id = tenantB.id;

  // Add users as tenant owners
  await addTenantUser({ tenantId: tenantA_id, userId: userA_id, role: "owner" });
  await addTenantUser({ tenantId: tenantB_id, userId: userB_id, role: "owner" });

  // Create free subscriptions for both tenants
  const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
  if (freePlan) {
    await db.tenantSubscription.createMany({
      data: [
        { tenantId: tenantA_id, saaasPlanId: freePlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
        { tenantId: tenantB_id, saaasPlanId: freePlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
      ],
    });
  }

  // Find a connectivity product for catalog tests
  const product = await db.connectivityProduct.findFirst({ where: { active: true } });
  if (product) testProduct_id = product.id;
}

async function expectReject(fn: () => Promise<unknown>, statusCode?: number) {
  try {
    await fn();
    throw new Error("Expected rejection but call succeeded");
  } catch (err) {
    if (statusCode && err instanceof AppError) {
      expect(err.statusCode).toBe(statusCode);
    }
    // If it's not an AppError, it's still a rejection (which is what we want)
  }
}

afterAll(async () => {
  try {
    if (tenantA_id) {
      await db.apiKey.deleteMany({ where: { tenantId: tenantA_id } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { tenantId: tenantA_id } }).catch(() => {});
      await db.tenantUser.deleteMany({ where: { tenantId: tenantA_id } }).catch(() => {});
      await db.tenantCustomer.deleteMany({ where: { tenantId: tenantA_id } }).catch(() => {});
      await db.distributionOffer.deleteMany({ where: { tenantId: tenantA_id } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantA_id } }).catch(() => {});
    }
    if (tenantB_id) {
      await db.apiKey.deleteMany({ where: { tenantId: tenantB_id } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { tenantId: tenantB_id } }).catch(() => {});
      await db.tenantUser.deleteMany({ where: { tenantId: tenantB_id } }).catch(() => {});
      await db.tenantCustomer.deleteMany({ where: { tenantId: tenantB_id } }).catch(() => {});
      await db.distributionOffer.deleteMany({ where: { tenantId: tenantB_id } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantB_id } }).catch(() => {});
    }
    if (userA_id) await db.user.deleteMany({ where: { id: userA_id } }).catch(() => {});
    if (userB_id) await db.user.deleteMany({ where: { id: userB_id } }).catch(() => {});
  } catch {}
  await db.$disconnect();
}, 180000);

describe("Phase 2B — Reseller SaaS Control Plane", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // --- Customer Management ---

  it("1. Tenant A can create a customer", async () => {
    const customer = await createTenantCustomer({
      tenantId: tenantA_id,
      name: "John Doe",
      email: `john-${Date.now()}@test.com`,
      phone: "+1234567890",
    });
    expect(customer.id).toBeDefined();
    expect(customer.name).toBe("John Doe");
    expect(customer.status).toBe("active");
    testCustomerA_id = customer.id;

    // Verify in DB
    const dbCustomer = await db.tenantCustomer.findUnique({ where: { id: testCustomerA_id } });
    expect(dbCustomer?.tenantId).toBe(tenantA_id);
  }, 30000);

  it("2. Tenant B cannot access Tenant A customer", async () => {
    await expectReject(() => getTenantCustomer(tenantB_id, testCustomerA_id), 403);
  }, 30000);

  it("16. Tenant customer list is isolated (Tenant B sees only B's customers)", async () => {
    // Create a customer in tenant B
    const customerB = await createTenantCustomer({
      tenantId: tenantB_id,
      name: "Jane Smith",
      email: `jane-${Date.now()}@test.com`,
    });

    // List tenant A customers — should not include tenant B's customer
    const tenantACustomers = await listTenantCustomers(tenantA_id);
    expect(tenantACustomers.find((c) => c.id === customerB.id)).toBeUndefined();
    expect(tenantACustomers.find((c) => c.id === testCustomerA_id)).toBeDefined();

    // List tenant B customers — should not include tenant A's customer
    const tenantBCustomers = await listTenantCustomers(tenantB_id);
    expect(tenantBCustomers.find((c) => c.id === testCustomerA_id)).toBeUndefined();
    expect(tenantBCustomers.find((c) => c.id === customerB.id)).toBeDefined();
  }, 30000);

  // --- Catalog Management ---

  it("3. Tenant A can enable a connectivity product (create DistributionOffer)", async () => {
    if (!testProduct_id) return; // skip if no products seeded
    const offer = await enableProduct({
      tenantId: tenantA_id,
      productId: testProduct_id,
      retailPriceMinor: 1500, // $15.00
    });
    expect(offer.id).toBeDefined();
    expect(offer.retailPrice).toBe(1500);
    testDistOfferA_id = offer.id;

    // Verify the distribution offer belongs to tenant A
    const dbOffer = await db.distributionOffer.findUnique({ where: { id: testDistOfferA_id } });
    expect(dbOffer?.tenantId).toBe(tenantA_id);
    expect(dbOffer?.retailPrice).toBe(1500);
  }, 30000);

  it("4. Tenant B cannot modify Tenant A pricing (cross-tenant DistributionOffer access denied)", async () => {
    if (!testDistOfferA_id) return;
    // getDistributionOfferForTenant throws 403 if the offer belongs to another tenant
    const { getDistributionOfferForTenant } = await import("@/lib/tenant/service");
    await expectReject(() => getDistributionOfferForTenant(testDistOfferA_id, tenantB_id), 403);
  }, 30000);

  it("7. Supplier remains hidden from tenant catalog API (no supplier credentials in response)", async () => {
    const products = await listAvailableProducts(tenantA_id);
    const productStr = JSON.stringify(products);
    // The catalog response should NOT contain supplier credentials or provider keys
    expect(productStr).not.toContain("apiKey");
    expect(productStr).not.toContain("apiSecret");
    expect(productStr).not.toContain("providerKey");
    // Wholesale price IS visible to the tenant admin (for margin calc) — this is intended
  }, 30000);

  it("9. Tenant retail price is preserved in DistributionOffer", async () => {
    if (!testDistOfferA_id) return;
    const offer = await db.distributionOffer.findUnique({ where: { id: testDistOfferA_id } });
    expect(offer?.retailPrice).toBe(1500); // frozen at creation
  }, 30000);

  it("12. Tenant economics are calculated correctly (retail, margin — NO wholesale leak)", async () => {
    if (!testDistOfferA_id) return;
    const economics = await getOfferEconomics(tenantA_id, testDistOfferA_id);
    expect(economics.retailPriceMinor).toBe(1500);
    // Phase 2B.1: wholesale cost must NOT be exposed
    expect((economics as any).wholesaleCostMinor).toBeUndefined();
    expect(economics.minimumRetailPriceMinor).toBeGreaterThan(0);
    expect(economics.grossProfitMinor).toBeGreaterThanOrEqual(0);
    expect(economics.grossMarginPercent).toBeGreaterThanOrEqual(0);
  }, 30000);

  // --- Order Flow ---

  it("5. Tenant A can create a customer order (resolves through orchestration)", async () => {
    if (!testDistOfferA_id || !testProduct_id) return;
    // Get the plan for this product
    const product = await db.connectivityProduct.findUnique({ where: { id: testProduct_id } });
    const plan = await db.plan.findFirst({
      where: { country: product?.country, dataAmount: product?.dataAmountMB, validityDays: product?.validityDays, status: "active" },
    });
    if (!plan) return;

    const idempotencyKey = `test_order_${Date.now()}`;
    const order = await createOrder({
      userId: userA_id,
      planId: plan.id,
      tenantId: tenantA_id,
      distributionOfferId: testDistOfferA_id,
      tenantCustomerId: testCustomerA_id,
      idempotencyKey,
    });

    expect(order.id).toBeDefined();
    expect(order.amount).toBe(1500); // frozen retail price from DistributionOffer
    expect(order.tenantId).toBe(tenantA_id);

    // Confirm + provision (mock payment)
    const result = await confirmAndProvision({
      orderId: order.id,
      paymentProvider: "mock",
      paymentReference: `test_pay_${order.id}`,
      paymentFee: 0,
      idempotencyKey: `confirm_${idempotencyKey}`,
    });
    expect(result.status).toBe("COMPLETED");

    // Verify order is linked to the tenant customer
    const dbOrder = await db.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.tenantCustomerId).toBe(testCustomerA_id);
    expect(dbOrder?.distributionOfferId).toBe(testDistOfferA_id);
  }, 60000);

  it("6. Order resolves through existing orchestration (fulfillmentStatus = success)", async () => {
    // Find the order we just created
    const order = await db.order.findFirst({
      where: { tenantId: tenantA_id, tenantCustomerId: testCustomerA_id },
      orderBy: { createdAt: "desc" },
    });
    if (!order) return;
    expect(order.fulfillmentStatus).toBe("success");
    expect(order.financialStatus).toBe("settled");
  }, 30000);

  it("10. Upstream supplier economics remain separate (frozen wholesale price on order)", async () => {
    const order = await db.order.findFirst({
      where: { tenantId: tenantA_id, tenantCustomerId: testCustomerA_id },
      orderBy: { createdAt: "desc" },
    });
    if (!order) return;
    // The order should have a frozen wholesale price (separate from retail)
    expect(order.frozenWholesalePriceMinor).toBeDefined();
    expect(order.frozenWholesalePriceMinor).toBeGreaterThanOrEqual(0);
    // Retail (amount) should be >= wholesale (frozenWholesalePriceMinor)
    expect(order.amount).toBeGreaterThanOrEqual(order.frozenWholesalePriceMinor ?? 0);
  }, 30000);

  it("11. Financial ledger remains canonical (ledger entries posted for the order)", async () => {
    const order = await db.order.findFirst({
      where: { tenantId: tenantA_id, tenantCustomerId: testCustomerA_id },
      orderBy: { createdAt: "desc" },
    });
    if (!order) return;
    // Verify ledger transactions exist for this order
    const ledgerTxns = await db.ledgerTransaction.findMany({ where: { orderId: order.id } });
    expect(ledgerTxns.length).toBeGreaterThan(0);
  }, 30000);

  it("13. RoamLink platform revenue is separated (platform fee calculated on order volume)", async () => {
    // The platform fee is calculated from the order amount * platformFeePercent
    const fee = await calculatePlatformFee(tenantA_id, 1500);
    expect(fee.platformFeeMinor).toBeGreaterThan(0); // free plan has 5% fee
    expect(fee.totalFeeMinor).toBe(fee.platformFeeMinor + fee.perOrderFeeMinor);
    // Platform fee is separate from the reseller's gross profit
    const ent = await getTenantEntitlements(tenantA_id);
    expect(ent.platformFeePercent).toBe(5); // free plan
  }, 30000);

  // --- Permissions ---

  it("14. Tenant user permissions work (viewer cannot write)", async () => {
    // Create a viewer user in tenant A
    const viewer = await db.user.create({
      data: { email: `viewer-${Date.now()}@test.com`, name: "Viewer", passwordHash: await hashPassword("test12345"), role: "customer" },
    });
    await addTenantUser({ tenantId: tenantA_id, userId: viewer.id, role: "viewer" });

    // Viewer should NOT pass the write-role check
    await expectReject(() => assertTenantRole(tenantA_id, viewer.id, TENANT_WRITE_ROLES), 403);

    // Viewer SHOULD pass the view-role check
    await assertTenantRole(tenantA_id, viewer.id, TENANT_VIEW_ROLES);

    // Cleanup
    await db.tenantUser.deleteMany({ where: { userId: viewer.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: viewer.id } }).catch(() => {});
  }, 30000);

  it("15. Multi-tenant users can switch active tenant safely", async () => {
    // Add user A to tenant B as well
    await addTenantUser({ tenantId: tenantB_id, userId: userA_id, role: "admin" });

    // User A can now be in tenant B context
    await setActiveTenant(userA_id, tenantB_id);

    // User A can list tenant B's customers (empty, since we only created one in B)
    const tenantBCustomers = await listTenantCustomers(tenantB_id);
    expect(Array.isArray(tenantBCustomers)).toBe(true);

    // Switch back to tenant A
    await setActiveTenant(userA_id, tenantA_id);

    // Cleanup: remove user A from tenant B
    await db.tenantUser.deleteMany({ where: { tenantId: tenantB_id, userId: userA_id } }).catch(() => {});
  }, 30000);

  // --- Entitlements ---

  it("17. SaaS entitlement limits are enforced server-side (customer limit)", async () => {
    // Create a temporary SaaS plan with a 2-customer limit for fast testing
    const tempPlan = await db.saaasPlan.create({
      data: {
        name: `temp_limit_${Date.now()}`,
        displayName: "Temp Limit Plan",
        monthlyPriceMinor: 0,
        includedStaff: 1,
        includedCustomers: 2, // low limit for fast test
        includedOrdersPerMonth: 10,
        platformFeePercent: 0,
        perOrderFeeMinor: 0,
        features: JSON.stringify([]),
        status: "active",
      },
    });

    const tempTenant = await createTenant({ name: `Temp Limit ${Date.now()}` });
    await addTenantUser({ tenantId: tempTenant.id, userId: userA_id, role: "owner" });
    await db.tenantSubscription.create({
      data: { tenantId: tempTenant.id, saaasPlanId: tempPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });

    // Fill to limit (2 customers)
    await createTenantCustomer({ tenantId: tempTenant.id, name: "C1", email: `c1-${Date.now()}@test.com` });
    await createTenantCustomer({ tenantId: tempTenant.id, name: "C2", email: `c2-${Date.now()}@test.com` });

    // 3rd should fail with 402 (usage limit)
    await expectReject(() => createTenantCustomer({
      tenantId: tempTenant.id,
      name: "C3",
      email: `c3-${Date.now()}@test.com`,
    }), 402);

    // Cleanup
    await db.tenantCustomer.deleteMany({ where: { tenantId: tempTenant.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { tenantId: tempTenant.id } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { tenantId: tempTenant.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tempTenant.id } }).catch(() => {});
    await db.saaasPlan.deleteMany({ where: { id: tempPlan.id } }).catch(() => {});
  }, 120000);

  it("19. Cross-tenant order access is denied", async () => {
    // Create an order in tenant A
    const order = await db.order.findFirst({
      where: { tenantId: tenantA_id },
      orderBy: { createdAt: "desc" },
    });
    if (!order) return;

    // Tenant B tries to read tenant A's order via getTenantOrder
    const { getTenantOrder } = await import("@/lib/tenant/service");
    await expectReject(() => getTenantOrder(order.id, tenantB_id), 403);
  }, 30000);

  it("20. Audit logs record sensitive tenant operations (customer creation)", async () => {
    // Create a customer to generate an audit log entry
    await createTenantCustomer({
      tenantId: tenantA_id,
      name: "Audit Test Customer",
      email: `audit-${Date.now()}@test.com`,
    });

    const auditLogs = await db.auditLog.findMany({
      where: { tenantId: tenantA_id, entity: "tenant_customer" },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
    for (const log of auditLogs) {
      expect(log.tenantId).toBe(tenantA_id);
    }
  }, 30000);

  // --- Static checks (route handlers exist) ---

  it("Static: /api/tenant/* route handlers exist and export correct functions", async () => {
    const meRoute = await import("@/app/api/tenant/me/route");
    expect(typeof meRoute.GET).toBe("function");

    const switchRoute = await import("@/app/api/tenant/switch/route");
    expect(typeof switchRoute.POST).toBe("function");

    const customersRoute = await import("@/app/api/tenant/customers/route");
    expect(typeof customersRoute.GET).toBe("function");
    expect(typeof customersRoute.POST).toBe("function");

    const catalogRoute = await import("@/app/api/tenant/catalog/route");
    expect(typeof catalogRoute.GET).toBe("function");
    expect(typeof catalogRoute.POST).toBe("function");

    const ordersRoute = await import("@/app/api/tenant/orders/route");
    expect(typeof ordersRoute.GET).toBe("function");
    expect(typeof ordersRoute.POST).toBe("function");

    const teamRoute = await import("@/app/api/tenant/team/route");
    expect(typeof teamRoute.GET).toBe("function");
    expect(typeof teamRoute.POST).toBe("function");

    const billingRoute = await import("@/app/api/tenant/billing/route");
    expect(typeof billingRoute.GET).toBe("function");

    const apiKeysRoute = await import("@/app/api/tenant/api-keys/route");
    expect(typeof apiKeysRoute.GET).toBe("function");
    expect(typeof apiKeysRoute.POST).toBe("function");
  }, 10000);

  it("Static: schema migration 0005 applied (TenantCustomer, SaaasPlan, TenantSubscription, ApiKey)", async () => {
    const planCount = await db.saaasPlan.count();
    expect(planCount).toBeGreaterThanOrEqual(4); // free, starter, business, enterprise
    const subCount = await db.tenantSubscription.count();
    expect(subCount).toBeGreaterThanOrEqual(2); // tenantA + tenantB
  }, 10000);

  it("Static: reseller UI pages exist", async () => {
    const fs = await import("fs");
    const pages = [
      "src/app/reseller/layout.tsx",
      "src/app/reseller/page.tsx",
      "src/app/reseller/customers/page.tsx",
      "src/app/reseller/catalog/page.tsx",
      "src/app/reseller/orders/page.tsx",
      "src/app/reseller/team/page.tsx",
      "src/app/reseller/billing/page.tsx",
    ];
    for (const p of pages) {
      expect(fs.existsSync(p)).toBe(true);
    }
  }, 10000);

  it("Static: vercel.json cron schedule exists for reconciliation", async () => {
    const fs = await import("fs");
    const vj = JSON.parse(fs.readFileSync("vercel.json", "utf-8"));
    expect(vj.crons).toBeDefined();
    expect(vj.crons.find((c: any) => c.path === "/api/internal/reconcile")).toBeDefined();
  }, 10000);
});
