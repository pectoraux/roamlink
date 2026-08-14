/**
 * Phase 2C.1 — Provider Adapter Interface Tests
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedConnectivityCapabilities, createEntitlement, transitionEntitlement, createResourceBinding, CAPABILITY_TYPES, ENTITLEMENT_STATES, BINDING_STATES } from "@/lib/connectivity/entitlement";
import { mockConnectivityProvider } from "@/lib/connectivity/mock-provider";
import { hashPassword } from "@/lib/security";
import { createTenant, addTenantUser } from "@/lib/tenant/service";

let setupDone = false;
let tenantId: string;
let userId: string;
let subscriptionId: string;
const entitlementIds: string[] = [];
const bindingIds: string[] = [];

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({ data: { email: `adapter-2c1-${Date.now()}@test.com`, name: "Adapter 2C.1", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Adapter 2C.1 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const sub = await db.tenantSubscription.create({ data: { tenantId, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionId = sub.id;
}

afterAll(async () => {
  try {
    for (const bid of bindingIds) await db.providerResourceBinding.deleteMany({ where: { id: bid } }).catch(() => {});
    for (const eid of entitlementIds) { await db.providerResourceBinding.deleteMany({ where: { entitlementId: eid } }).catch(() => {}); await db.connectivityEntitlement.deleteMany({ where: { id: eid } }).catch(() => {}); }
    if (subscriptionId) await db.tenantSubscription.deleteMany({ where: { id: subscriptionId } }).catch(() => {});
    if (tenantId) { await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {}); await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {}); }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

async function createProvisionedBinding() {
  const ent = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });
  const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mock", userId });
  bindingIds.push(binding.id);
  const fullEnt = await db.connectivityEntitlement.findUnique({ where: { id: ent.id }, include: { capability: true } });
  const fullBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
  return { ent: fullEnt!, binding: fullBinding! };
}

function makeEntInput(ent: any) {
  return { id: ent.id, tenantId: ent.tenantId, subscriptionId: ent.subscriptionId, status: ent.status, capabilityType: ent.capability.type, capabilitySet: JSON.parse(ent.capabilitySet), policy: ent.policy ? JSON.parse(ent.policy) : null, validFrom: ent.validFrom, validUntil: ent.validUntil };
}
function makeBindingInput(binding: any, providerResourceId?: string, providerMetadata?: any) {
  return { id: binding.id, entitlementId: binding.entitlementId, providerType: binding.providerType, providerResourceId: providerResourceId ?? binding.providerResourceId, providerMetadata: providerMetadata ?? (binding.providerMetadata ? JSON.parse(binding.providerMetadata) : null), status: binding.status, provisioningState: binding.provisioningState };
}

describe("Phase 2C.1 — Provider Adapter Interface", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Mock adapter implements ConnectivityProviderAdapter interface", async () => {
    expect(mockConnectivityProvider.providerType).toBe("mock");
    expect(mockConnectivityProvider.label).toContain("Mock");
    expect(typeof mockConnectivityProvider.provision).toBe("function");
    expect(typeof mockConnectivityProvider.suspend).toBe("function");
    expect(typeof mockConnectivityProvider.resume).toBe("function");
    expect(typeof mockConnectivityProvider.release).toBe("function");
    expect(typeof mockConnectivityProvider.getUsage).toBe("function");
  }, 30000);

  it("B. provision() is idempotent", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const r1 = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    expect(r1.status).toBe("success");
    expect(r1.providerResourceId).toBeTruthy();
    const r2 = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding, r1.providerResourceId, r1.providerMetadata) });
    expect(r2.status).toBe("success");
    expect(r2.providerResourceId).toBe(r1.providerResourceId);
  }, 30000);

  it("C. suspend/resume cycle works", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    const bi = makeBindingInput(binding, p.providerResourceId, p.providerMetadata);
    const s = await mockConnectivityProvider.suspend({ entitlement: makeEntInput(ent), binding: bi });
    expect(s.status).toBe("success");
    const r = await mockConnectivityProvider.resume({ entitlement: makeEntInput(ent), binding: bi });
    expect(r.status).toBe("success");
  }, 30000);

  it("D. release() cleans up", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    const r = await mockConnectivityProvider.release({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding, p.providerResourceId, p.providerMetadata) });
    expect(r.status).toBe("success");
  }, 30000);

  it("E. getUsage() returns metrics", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    const u = await mockConnectivityProvider.getUsage({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding, p.providerResourceId, p.providerMetadata) });
    expect(u).toBeDefined();
    expect(u?.isActive).toBe(true);
    expect(u?.measuredAt).toBeInstanceOf(Date);
  }, 30000);

  it("Static: adapter.ts defines ConnectivityProviderAdapter interface", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/adapter.ts", "utf-8");
    expect(source).toContain("interface ConnectivityProviderAdapter");
    expect(source).toContain("readonly providerType: string");
    expect(source).toContain("readonly label: string");
  }, 10000);

  it("Static: ProvisionResult has 4 status values", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/adapter.ts", "utf-8");
    expect(source).toContain('"success" | "pending" | "failed_retryable" | "failed_permanent"');
  }, 10000);

  it("Static: interface has all 5 methods", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/adapter.ts", "utf-8");
    expect(source).toContain("provision(");
    expect(source).toContain("suspend(");
    expect(source).toContain("resume(");
    expect(source).toContain("release(");
    expect(source).toContain("getUsage(");
  }, 10000);

  it("Static: mock provider implements the interface", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/mock-provider.ts", "utf-8");
    expect(source).toContain("class MockConnectivityProvider implements ConnectivityProviderAdapter");
    expect(source).toContain('readonly providerType = "mock"');
  }, 10000);
});
