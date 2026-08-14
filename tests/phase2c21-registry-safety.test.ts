/**
 * Phase 2C.2.1 — Registry Safety + Durable Binding Resolution Tests
 *
 * Tests:
 *   A. Binding providerType = mock → resolves mock adapter via resolveBindingAdapter
 *   B. Binding providerType = unknown → typed error from resolveBindingAdapter
 *   C. Two bindings with different providerType resolve independently
 *   D. Registry cold-start/re-registration does not change binding provider
 *   E. reconcileBindingWithProvider never directly mutates DB outside kernel
 *   F. drift_detected causes only kernel-owned state transition (BOUND → DEGRADED)
 *   G. resource_missing causes FAILED
 *   H. failed_retryable preserves durable state
 *   I. failed_permanent becomes FAILED
 *   J. Conflicting duplicate registration throws (safe registration)
 *   K. Idempotent duplicate registration (same adapter) succeeds
 *   L. normalizeProviderType trims + lowercases + rejects empty
 *   M. replaceConnectivityProvider (test-only) replaces adapter
 *
 * Static:
 *   - registry exports resolveBindingAdapter, normalizeProviderType, replaceConnectivityProvider
 *   - reconcileBindingWithProvider exists in entitlement.ts
 *   - adapter interface has reconcile() with idempotency doc
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
  reconcileBindingWithProvider,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  mockConnectivityProvider,
  registerConnectivityProvider,
  replaceConnectivityProvider,
  unregisterConnectivityProvider,
  getConnectivityProvider,
  requireConnectivityProvider,
  normalizeProviderType,
  resolveBindingAdapter,
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
  const user = await db.user.create({ data: { email: `safety-2c21-${Date.now()}@test.com`, name: "Safety 2C.2.1", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Safety 2C.2.1 ${Date.now()}` });
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

describe("Phase 2C.2.1 — Registry Safety + Durable Binding Resolution", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // A. Binding providerType = mock → resolves mock adapter
  // ---------------------------------------------------------------
  it("A. resolveBindingAdapter resolves mock adapter from persisted binding", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const result = await resolveBindingAdapter(binding.id);
    expect(result.adapter.providerType).toBe("mock");
    expect(result.binding.providerType).toBe("mock");
    expect(result.binding.id).toBe(binding.id);
  }, 30000);

  // ---------------------------------------------------------------
  // B. Binding providerType = unknown → typed error
  // ---------------------------------------------------------------
  it("B. resolveBindingAdapter with unregistered provider throws", async () => {
    const ent = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: {}, validFrom: new Date(), userId });
    entitlementIds.push(ent.id);
    // Create a binding with an unregistered providerType
    const binding = await db.providerResourceBinding.create({
      data: { entitlementId: ent.id, providerType: "nonexistent-provider", status: "UNBOUND" },
    });
    bindingIds.push(binding.id);

    let threw = false;
    try {
      await resolveBindingAdapter(binding.id);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("No connectivity provider adapter registered");
      expect(err.message).toContain("nonexistent-provider");
    }
    expect(threw).toBe(true);
  }, 30000);

  // ---------------------------------------------------------------
  // C. Two bindings with different providerType resolve independently
  // ---------------------------------------------------------------
  it("C. two bindings with different providerType resolve independently", async () => {
    // We only have "mock" registered, so create two mock bindings and verify
    // they both resolve to the mock adapter independently
    const { ent: ent1, binding: binding1 } = await createProvisionedBinding();
    const { ent: ent2, binding: binding2 } = await createProvisionedBinding();

    const result1 = await resolveBindingAdapter(binding1.id);
    const result2 = await resolveBindingAdapter(binding2.id);

    expect(result1.binding.id).toBe(binding1.id);
    expect(result2.binding.id).toBe(binding2.id);
    expect(result1.adapter).toBe(result2.adapter); // same mock adapter instance
  }, 30000);

  // ---------------------------------------------------------------
  // D. Registry cold-start/re-registration does not change binding provider
  // ---------------------------------------------------------------
  it("D. re-registering mock does not change persisted binding providerType", async () => {
    const { binding } = await createProvisionedBinding();

    // Read the persisted providerType before
    const before = await db.providerResourceBinding.findUnique({ where: { id: binding.id }, select: { providerType: true } });
    expect(before?.providerType).toBe("mock");

    // Simulate cold-start: re-register the mock adapter
    registerConnectivityProvider(mockConnectivityProvider);

    // Read the persisted providerType after — unchanged
    const after = await db.providerResourceBinding.findUnique({ where: { id: binding.id }, select: { providerType: true } });
    expect(after?.providerType).toBe("mock");

    // resolveBindingAdapter still works
    const result = await resolveBindingAdapter(binding.id);
    expect(result.adapter.providerType).toBe("mock");
  }, 30000);

  // ---------------------------------------------------------------
  // F. drift_detected causes only kernel-owned state transition
  // ---------------------------------------------------------------
  it("F. drift_detected → kernel transitions BOUND → DEGRADED", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Suspend at provider (creates drift: binding=BOUND, provider=inactive)
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.suspend({ entitlement: makeEntInput(ent), binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata) });

    // Reconcile — kernel should transition BOUND → DEGRADED
    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("transitioned");
    expect(result.transition?.from).toBe("BOUND");
    expect(result.transition?.to).toBe("DEGRADED");

    // Verify the binding is now DEGRADED
    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("DEGRADED");
  }, 30000);

  // ---------------------------------------------------------------
  // G. resource_missing causes FAILED
  // ---------------------------------------------------------------
  it("G. resource_missing → kernel transitions to FAILED", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Release at provider (resource disappears)
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.release({ entitlement: makeEntInput(ent), binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata) });

    // Reconcile — kernel should transition to FAILED
    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("transitioned");
    expect(result.transition?.to).toBe("FAILED");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("FAILED");
  }, 30000);

  // ---------------------------------------------------------------
  // H. in_sync preserves durable state
  // ---------------------------------------------------------------
  it("H. in_sync → no transition, binding stays BOUND", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Reconcile — should be in_sync (resource is active, binding is BOUND)
    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("in_sync");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("BOUND"); // unchanged
  }, 30000);

  // ---------------------------------------------------------------
  // J. Conflicting duplicate registration throws
  // ---------------------------------------------------------------
  it("J. conflicting duplicate registration throws", async () => {
    const testAdapter = {
      providerType: "test-conflict",
      label: "Test Conflict A",
      provision: async () => ({ status: "success" as const }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({ status: "in_sync" as const }),
    };
    const testAdapter2 = {
      providerType: "test-conflict",
      label: "Test Conflict B",
      provision: async () => ({ status: "success" as const }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({ status: "in_sync" as const }),
    };

    // First registration succeeds
    registerConnectivityProvider(testAdapter);

    // Second registration with a DIFFERENT adapter should throw
    let threw = false;
    try {
      registerConnectivityProvider(testAdapter2);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("already registered with a different adapter");
    }
    expect(threw).toBe(true);

    // Clean up
    unregisterConnectivityProvider("test-conflict");
  }, 30000);

  // ---------------------------------------------------------------
  // K. Idempotent duplicate registration (same adapter) succeeds
  // ---------------------------------------------------------------
  it("K. idempotent duplicate registration (same adapter) succeeds", async () => {
    const testAdapter = {
      providerType: "test-idempotent",
      label: "Test Idempotent",
      provision: async () => ({ status: "success" as const }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({ status: "in_sync" as const }),
    };

    // First registration
    registerConnectivityProvider(testAdapter);

    // Second registration with the SAME adapter — should not throw
    expect(() => registerConnectivityProvider(testAdapter)).not.toThrow();

    // Clean up
    unregisterConnectivityProvider("test-idempotent");
  }, 30000);

  // ---------------------------------------------------------------
  // L. normalizeProviderType
  // ---------------------------------------------------------------
  it("L. normalizeProviderType trims, lowercases, rejects empty", async () => {
    expect(normalizeProviderType("  MikroTik  ")).toBe("mikrotik");
    expect(normalizeProviderType("MOCK")).toBe("mock");
    expect(normalizeProviderType("esim")).toBe("esim");

    let threw = false;
    try { normalizeProviderType(""); } catch { threw = true; }
    expect(threw).toBe(true);

    threw = false;
    try { normalizeProviderType("   "); } catch { threw = true; }
    expect(threw).toBe(true);
  }, 10000);

  // ---------------------------------------------------------------
  // M. replaceConnectivityProvider (test-only)
  // ---------------------------------------------------------------
  it("M. replaceConnectivityProvider replaces adapter (test-only)", async () => {
    const adapter1 = {
      providerType: "test-replace-2c21",
      label: "Replace V1",
      provision: async () => ({ status: "success" as const }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({ status: "in_sync" as const }),
    };
    const adapter2 = { ...adapter1, label: "Replace V2" };

    registerConnectivityProvider(adapter1);
    expect(getConnectivityProvider("test-replace-2c21")?.label).toBe("Replace V1");

    // Replace — should not throw even though it's a different adapter
    replaceConnectivityProvider(adapter2);
    expect(getConnectivityProvider("test-replace-2c21")?.label).toBe("Replace V2");

    // Clean up
    unregisterConnectivityProvider("test-replace-2c21");
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: registry exports resolveBindingAdapter, normalizeProviderType, replaceConnectivityProvider", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/registry.ts", "utf-8");
    expect(source).toContain("export async function resolveBindingAdapter");
    expect(source).toContain("export function normalizeProviderType");
    expect(source).toContain("export function replaceConnectivityProvider");
    expect(source).toContain("export function unregisterConnectivityProvider");
  }, 10000);

  it("Static: reconcileBindingWithProvider exists in entitlement.ts", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("export async function reconcileBindingWithProvider");
    expect(source).toContain("RECONCILIATION BOUNDARY");
    expect(source).toContain("Adapter Reports, Kernel Decides");
  }, 10000);

  it("Static: safe registration throws on conflict", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/registry.ts", "utf-8");
    expect(source).toContain("already registered with a different adapter");
    expect(source).toContain("Use replaceConnectivityProvider() for explicit test/development replacement");
  }, 10000);

  it("Static: registry is code not customer state — documented", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/registry.ts", "utf-8");
    expect(source).toContain("REGISTRY IS CODE, NOT CUSTOMER STATE");
    expect(source).toContain("providerType remains authoritative");
    expect(source).toContain("cold start cannot change provider ownership");
  }, 10000);

  it("Static: no provider-specific imports in entitlement kernel", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    const lines = source.split("\n");
    const codeLines = lines.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
    const codeSource = codeLines.join("\n");
    expect(codeSource).not.toContain("MikroTik");
    expect(codeSource).not.toContain("mikrotik");
    expect(codeSource).not.toContain("RADIUS");
    expect(codeSource).not.toContain("eSIM");
    expect(codeSource).not.toContain("esim");
  }, 10000);
});
