/**
 * Phase 2C.2 — Provider Adapter Registry Tests
 *
 * Tests:
 *   A. Mock provider is auto-registered
 *   B. getConnectivityProvider returns the adapter by type
 *   C. requireConnectivityProvider throws for unknown type
 *   D. listRegisteredProviderTypes returns all registered types
 *   E. isProviderRegistered checks correctly
 *   F. registerConnectivityProvider replaces existing adapter
 *   G. reconcile() returns in_sync for active BOUND binding
 *   H. reconcile() detects drift (inactive resource, BOUND binding)
 *   I. reconcile() detects resource_missing
 *   J. reconcile() returns in_sync for DEGRADED binding with inactive resource
 *
 * Static:
 *   - registry.ts exports all required functions
 *   - adapter interface has reconcile() method
 *   - ReconciliationResult has 5 status values
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import {
  seedConnectivityCapabilities,
  createEntitlement,
  transitionEntitlement,
  createResourceBinding,
  transitionBinding,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  mockConnectivityProvider,
  registerConnectivityProvider,
  getConnectivityProvider,
  requireConnectivityProvider,
  listRegisteredProviderTypes,
  isProviderRegistered,
} from "@/lib/connectivity";
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
  const user = await db.user.create({ data: { email: `registry-2c2-${Date.now()}@test.com`, name: "Registry 2C.2", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Registry 2C.2 ${Date.now()}` });
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

describe("Phase 2C.2 — Provider Adapter Registry", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // Registry tests
  // ---------------------------------------------------------------
  it("A. Mock provider is auto-registered", async () => {
    const adapter = getConnectivityProvider("mock");
    expect(adapter).toBeDefined();
    expect(adapter?.providerType).toBe("mock");
  }, 30000);

  it("B. getConnectivityProvider returns adapter by type (case-insensitive)", async () => {
    expect(getConnectivityProvider("mock")?.providerType).toBe("mock");
    expect(getConnectivityProvider("MOCK")?.providerType).toBe("mock");
    expect(getConnectivityProvider("Mock")?.providerType).toBe("mock");
  }, 30000);

  it("C. requireConnectivityProvider throws for unknown type", async () => {
    let threw = false;
    try {
      requireConnectivityProvider("nonexistent");
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("No connectivity provider adapter registered");
      expect(err.message).toContain("nonexistent");
    }
    expect(threw).toBe(true);
  }, 30000);

  it("D. listRegisteredProviderTypes returns all registered types", async () => {
    const types = listRegisteredProviderTypes();
    expect(types).toContain("mock");
    expect(types.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("E. isProviderRegistered checks correctly", async () => {
    expect(isProviderRegistered("mock")).toBe(true);
    expect(isProviderRegistered("nonexistent")).toBe(false);
  }, 30000);

  it("F. registerConnectivityProvider replaces existing adapter", async () => {
    // Create a test adapter
    const testAdapter = {
      providerType: "test-replace",
      label: "Test Replace",
      provision: async () => ({ status: "success" as const }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({ status: "in_sync" as const }),
    };
    registerConnectivityProvider(testAdapter);
    expect(getConnectivityProvider("test-replace")?.label).toBe("Test Replace");

    // Replace it
    const testAdapter2 = { ...testAdapter, label: "Test Replace 2" };
    registerConnectivityProvider(testAdapter2);
    expect(getConnectivityProvider("test-replace")?.label).toBe("Test Replace 2");
  }, 30000);

  // ---------------------------------------------------------------
  // reconcile() tests
  // ---------------------------------------------------------------
  it("G. reconcile() returns in_sync for active BOUND binding", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    const result = await mockConnectivityProvider.reconcile({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata),
    });

    expect(result.status).toBe("in_sync");
    expect(result.observedState).toBe("active");
  }, 30000);

  it("H. reconcile() detects drift (inactive resource, BOUND binding)", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Suspend the resource at the provider (simulating provider-side issue)
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.suspend({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata),
    });

    // Reconcile — should detect drift
    const result = await mockConnectivityProvider.reconcile({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata),
    });

    expect(result.status).toBe("drift_detected");
    expect(result.observedState).toBe("inactive");
    expect(result.recommendedBindingState).toBe("DEGRADED");
  }, 30000);

  it("I. reconcile() detects resource_missing", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Release the resource at the provider (simulating provider-side deletion)
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.release({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata),
    });

    // Reconcile — should detect resource_missing
    const result = await mockConnectivityProvider.reconcile({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata),
    });

    expect(result.status).toBe("resource_missing");
    expect(result.observedState).toBe("not_found");
    expect(result.recommendedBindingState).toBe("FAILED");
  }, 30000);

  it("J. reconcile() returns in_sync for DEGRADED binding with inactive resource", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Suspend at provider + transition binding to DEGRADED
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.suspend({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata),
    });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.DEGRADED, reason: "Provider resource inactive" });

    const degradedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    const result = await mockConnectivityProvider.reconcile({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(degradedBinding!, p.providerResourceId, p.providerMetadata),
    });

    expect(result.status).toBe("in_sync");
    expect(result.observedState).toBe("inactive");
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: registry.ts exports all required functions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/registry.ts", "utf-8");
    expect(source).toContain("export function registerConnectivityProvider");
    expect(source).toContain("export function getConnectivityProvider");
    expect(source).toContain("export function requireConnectivityProvider");
    expect(source).toContain("export function listRegisteredProviderTypes");
    expect(source).toContain("export function isProviderRegistered");
  }, 10000);

  it("Static: adapter interface has reconcile() method", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/adapter.ts", "utf-8");
    expect(source).toContain("reconcile(");
    expect(source).toContain("ReconciliationResult");
    expect(source).toContain("Idempotent: calling reconcile() multiple times is safe");
  }, 10000);

  it("Static: ReconciliationResult has 5 status values", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/adapter.ts", "utf-8");
    expect(source).toContain('"in_sync" | "drift_detected" | "resource_missing" | "failed_retryable" | "failed_permanent"');
  }, 10000);

  it("Static: mock provider implements reconcile()", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/mock-provider.ts", "utf-8");
    expect(source).toContain("async reconcile(");
    expect(source).toContain("mock.connectivity.reconcile");
  }, 10000);

  it("Static: index.ts barrel exports all modules", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/index.ts", "utf-8");
    expect(source).toContain('from "./entitlement"');
    expect(source).toContain('from "./adapter"');
    expect(source).toContain('from "./registry"');
    expect(source).toContain('from "./mock-provider"');
  }, 10000);
});
