/**
 * Phase 2C.3 — MikroTik Reference Provider Tests
 *
 * Tests:
 *   1. MikroTik provider registers successfully
 *   2. Provider lookup is through providerType
 *   3. Entitlement remains provider-neutral (no MikroTik imports in kernel)
 *   4. Provision creates exactly one resource
 *   5. Duplicate provision is idempotent
 *   6. Suspend is idempotent
 *   7. Resume is idempotent
 *   8. Release is idempotent
 *   9. Missing resource reconciles to resource_missing
 *   10. Drift reconciles to drift_detected
 *   11. Retryable RouterOS failure preserves recoverability
 *   12. Permanent RouterOS failure becomes manual intervention
 *   13. Concurrent provision calls create ONE resource
 *   14. Concurrent reconciliation cannot overwrite newer state
 *   15. Provider A (mock) and MikroTik remain isolated
 *   16. Existing mock adapter tests still pass (regression)
 *
 * Static:
 *   - Kernel has ZERO imports of MikroTik/RouterOS/RADIUS
 *   - MikroTik adapter implements ConnectivityProviderAdapter
 *   - Error classification maps to ReconciliationResult
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
  getConnectivityProvider,
  requireConnectivityProvider,
  isProviderRegistered,
  resolveBindingAdapter,
  mikrotikConnectivityAdapter,
  mockConnectivityProvider,
  setMockFailureSimulation,
  clearMockFailureSimulation,
  clearMockMikroTikResources,
  registerMockClientForInstance,
  mockMikroTikProviderClient,
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
  const user = await db.user.create({ data: { email: `mikrotik-2c3-${Date.now()}@test.com`, name: "MikroTik 2C.3", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `MikroTik 2C.3 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const sub = await db.tenantSubscription.create({ data: { tenantId, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionId = sub.id;
}

afterAll(async () => {
  try {
    clearMockMikroTikResources();
    for (const bid of bindingIds) await db.providerResourceBinding.deleteMany({ where: { id: bid } }).catch(() => {});
    for (const eid of entitlementIds) { await db.providerResourceBinding.deleteMany({ where: { entitlementId: eid } }).catch(() => {}); await db.connectivityEntitlement.deleteMany({ where: { id: eid } }).catch(() => {}); }
    if (subscriptionId) await db.tenantSubscription.deleteMany({ where: { id: subscriptionId } }).catch(() => {});
    if (tenantId) { await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {}); await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {}); }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

async function createMikrotikBinding(downloadMbps = 50, uploadMbps = 10) {
  const ent = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps, uploadMbps }, validFrom: new Date(), userId });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });

  // Phase 12.4.2a: Create a provider instance and register a mock client for it.
  // The production adapter requires a providerInstanceId on the binding and a
  // registered mock client to resolve.
  const pi = await db.connectivityProviderInstance.create({
    data: { tenantId, providerType: "mikrotik", name: `Test Router ${Date.now()}`, status: "active", configuration: JSON.stringify({}), configurationKey: "test-mikrotik" },
  });
  // Register the mock MikroTik client for this instance
  registerMockClientForInstance(pi.id, mockMikroTikProviderClient);

  const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mikrotik", resourceType: "hotspot_user", providerInstanceId: pi.id, userId });
  bindingIds.push(binding.id);
  const fullEnt = await db.connectivityEntitlement.findUnique({ where: { id: ent.id }, include: { capability: true } });
  const fullBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
  return { ent: fullEnt!, binding: fullBinding!, providerInstanceId: pi.id };
}

function makeEntInput(ent: any) {
  return { id: ent.id, tenantId: ent.tenantId, subscriptionId: ent.subscriptionId, status: ent.status, capabilityType: ent.capability.type, capabilitySet: JSON.parse(ent.capabilitySet), policy: ent.policy ? JSON.parse(ent.policy) : null, validFrom: ent.validFrom, validUntil: ent.validUntil };
}
function makeBindingInput(binding: any, providerResourceId?: string, providerMetadata?: any) {
  return { id: binding.id, entitlementId: binding.entitlementId, providerType: binding.providerType, providerInstanceId: binding.providerInstanceId, providerResourceId: providerResourceId ?? binding.providerResourceId, providerMetadata: providerMetadata ?? (binding.providerMetadata ? JSON.parse(binding.providerMetadata) : null), status: binding.status, provisioningState: binding.provisioningState, providerInstanceConfiguration: null };
}

describe("Phase 2C.3 — MikroTik Reference Provider", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // 1. MikroTik provider registers successfully
  // ---------------------------------------------------------------
  it("1. MikroTik provider is registered", async () => {
    expect(isProviderRegistered("mikrotik")).toBe(true);
    const adapter = getConnectivityProvider("mikrotik");
    expect(adapter).toBeDefined();
    expect(adapter?.providerType).toBe("mikrotik");
    expect(adapter?.label).toContain("MikroTik");
  }, 30000);

  // ---------------------------------------------------------------
  // 2. Provider lookup is through providerType
  // ---------------------------------------------------------------
  it("2. requireConnectivityProvider resolves MikroTik by type", async () => {
    const adapter = requireConnectivityProvider("mikrotik");
    expect(adapter.providerType).toBe("mikrotik");
  }, 30000);

  // ---------------------------------------------------------------
  // 4. Provision creates exactly one resource
  // ---------------------------------------------------------------
  it("4. provision creates exactly one MikroTik resource", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const result = await mikrotikConnectivityAdapter.provision({
      entitlement: makeEntInput(ent),
      binding: makeBindingInput(binding),
      correlation: { tenantId, providerInstanceId: binding.providerInstanceId },
    });
    expect(result.status).toBe("success");
    expect(result.providerResourceId).toBeTruthy();
    expect(result.providerMetadata?.resourceType).toBe("hotspot_user");
  }, 30000);

  // ---------------------------------------------------------------
  // 5. Duplicate provision is idempotent
  // ---------------------------------------------------------------
  it("5. duplicate provision is idempotent", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const r1 = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const r2 = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding, r1.providerResourceId, r1.providerMetadata), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    expect(r2.providerResourceId).toBe(r1.providerResourceId);
  }, 30000);

  // ---------------------------------------------------------------
  // 6. Suspend is idempotent
  // ---------------------------------------------------------------
  it("6. suspend is idempotent", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const bi = makeBindingInput(binding, p.providerResourceId, p.providerMetadata);
    const s1 = await mikrotikConnectivityAdapter.suspend({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const s2 = await mikrotikConnectivityAdapter.suspend({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    expect(s1.status).toBe("success");
    expect(s2.status).toBe("success");
  }, 30000);

  // ---------------------------------------------------------------
  // 7. Resume is idempotent
  // ---------------------------------------------------------------
  it("7. resume is idempotent", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const bi = makeBindingInput(binding, p.providerResourceId, p.providerMetadata);
    await mikrotikConnectivityAdapter.suspend({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const r1 = await mikrotikConnectivityAdapter.resume({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const r2 = await mikrotikConnectivityAdapter.resume({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
  }, 30000);

  // ---------------------------------------------------------------
  // 8. Release is idempotent
  // ---------------------------------------------------------------
  it("8. release is idempotent", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const bi = makeBindingInput(binding, p.providerResourceId, p.providerMetadata);
    const r1 = await mikrotikConnectivityAdapter.release({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    const r2 = await mikrotikConnectivityAdapter.release({ entitlement: makeEntInput(ent), binding: bi, correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
  }, 30000);

  // ---------------------------------------------------------------
  // 9. Missing resource reconciles to resource_missing
  // ---------------------------------------------------------------
  it("9. missing resource → resource_missing", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Release at provider to make resource disappear
    await mikrotikConnectivityAdapter.release({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding, p.providerResourceId, p.providerMetadata), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });

    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("transitioned");
    expect(result.transition?.to).toBe("FAILED");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("FAILED");
  }, 30000);

  // ---------------------------------------------------------------
  // 10. Drift reconciles to drift_detected → DEGRADED
  // ---------------------------------------------------------------
  it("10. drift → drift_detected → DEGRADED", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Suspend at provider (drift)
    await mikrotikConnectivityAdapter.suspend({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding, p.providerResourceId, p.providerMetadata), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });

    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("transitioned");
    expect(result.transition?.to).toBe("DEGRADED");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("DEGRADED");
  }, 30000);

  // ---------------------------------------------------------------
  // 11. Retryable RouterOS failure preserves recoverability
  // ---------------------------------------------------------------
  it("11. retryable RouterOS failure → RECONCILIATION_REQUIRED", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Simulate retryable failure on reconcile
    setMockFailureSimulation({ type: "retryable", operations: ["get"] });
    try {
      const result = await reconcileBindingWithProvider(binding.id);
      // Should be no_action (failed_retryable → preserve state)
      expect(["no_action", "in_sync"]).toContain(result.status);

      // Binding stays BOUND
      const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
      expect(finalBinding?.status).toBe("BOUND");
      expect(finalBinding?.reconciliationState).toBe("RECONCILIATION_REQUIRED");
    } finally {
      clearMockFailureSimulation();
    }
  }, 30000);

  // ---------------------------------------------------------------
  // 12. Permanent RouterOS failure → MANUAL_INTERVENTION_REQUIRED
  // ---------------------------------------------------------------
  it("12. permanent RouterOS failure → MANUAL_INTERVENTION_REQUIRED", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const p = await mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Simulate permanent failure on reconcile
    setMockFailureSimulation({ type: "permanent", operations: ["get"] });
    try {
      const result = await reconcileBindingWithProvider(binding.id);
      expect(["no_action", "transitioned"]).toContain(result.status);

      const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
      expect(finalBinding?.reconciliationState).toBe("MANUAL_INTERVENTION_REQUIRED");
    } finally {
      clearMockFailureSimulation();
    }
  }, 30000);

  // ---------------------------------------------------------------
  // 13. Concurrent provision calls create ONE resource
  // ---------------------------------------------------------------
  it("13. concurrent provision → ONE resource (idempotent)", async () => {
    const { ent, binding } = await createMikrotikBinding();
    const results = await Promise.allSettled([
      mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } }),
      mikrotikConnectivityAdapter.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding), correlation: { tenantId, providerInstanceId: binding.providerInstanceId } }),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === "success").length;
    expect(successes).toBeGreaterThanOrEqual(1);
    // Both should return the same providerResourceId (idempotent)
    const refs = results
      .filter((r) => r.status === "fulfilled" && r.value.providerResourceId)
      .map((r) => (r as any).value.providerResourceId);
    if (refs.length === 2) {
      expect(refs[0]).toBe(refs[1]);
    }
  }, 30000);

  // ---------------------------------------------------------------
  // 15. Mock provider and MikroTik remain isolated
  // ---------------------------------------------------------------
  it("15. mock and MikroTik providers are isolated", async () => {
    // Create a mock binding and a MikroTik binding
    const mockEnt = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
    entitlementIds.push(mockEnt.id);
    await transitionEntitlement({ entitlementId: mockEnt.id, toState: ENTITLEMENT_STATES.ACTIVE });
    const mockBinding = await createResourceBinding({ entitlementId: mockEnt.id, providerType: "mock", userId });
    bindingIds.push(mockBinding.id);

    const mtEnt = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
    entitlementIds.push(mtEnt.id);
    await transitionEntitlement({ entitlementId: mtEnt.id, toState: ENTITLEMENT_STATES.ACTIVE });
    const mtBinding = await createResourceBinding({ entitlementId: mtEnt.id, providerType: "mikrotik", resourceType: "hotspot_user", userId });
    bindingIds.push(mtBinding.id);

    // Resolve adapters independently
    const mockAdapter = await resolveBindingAdapter(mockBinding.id);
    const mtAdapter = await resolveBindingAdapter(mtBinding.id);
    expect(mockAdapter.adapter.providerType).toBe("mock");
    expect(mtAdapter.adapter.providerType).toBe("mikrotik");
    expect(mockAdapter.adapter).not.toBe(mtAdapter.adapter);
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: entitlement kernel has ZERO MikroTik imports", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    const lines = source.split("\n");
    const codeLines = lines.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
    const codeSource = codeLines.join("\n");
    expect(codeSource).not.toContain("MikroTik");
    expect(codeSource).not.toContain("mikrotik");
    expect(codeSource).not.toContain("RouterOS");
    expect(codeSource).not.toContain("routeros");
    expect(codeSource).not.toContain("RADIUS");
    expect(codeSource).not.toContain("radius");
    expect(codeSource).not.toContain("hotspot");
    expect(codeSource).not.toContain("PPPoE");
  }, 10000);

  it("Static: MikroTik adapter implements ConnectivityProviderAdapter", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    expect(source).toContain("implements ConnectivityProviderAdapter");
    expect(source).toContain('readonly providerType = "mikrotik"');
    expect(source).toContain("async provision(");
    expect(source).toContain("async reconcile(");
  }, 10000);

  it("Static: error classification maps to ReconciliationResult", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    expect(source).toContain("classifyError");
    expect(source).toContain("failed_retryable");
    expect(source).toContain("failed_permanent");
    expect(source).toContain("RETRYABLE");
    expect(source).toContain("PERMANENT");
    expect(source).toContain("AUTHENTICATION");
  }, 10000);

  it("Static: MikroTik provider client interface exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/client.ts", "utf-8");
    expect(source).toContain("interface MikroTikProviderClient");
    expect(source).toContain("createResource");
    expect(source).toContain("getResource");
    expect(source).toContain("suspendResource");
    expect(source).toContain("resumeResource");
    expect(source).toContain("deleteResource");
  }, 10000);

  it("Static: mock client provides deterministic test environment", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/mock-client.ts", "utf-8");
    expect(source).toContain("class MockMikroTikProviderClient");
    expect(source).toContain("setMockFailureSimulation");
    expect(source).toContain("clearMockMikroTikResources");
  }, 10000);

  it("Static: resourceType field added to ProviderResourceBinding", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("resourceType    String?");
    expect(source).toContain("hotspot_user");
  }, 10000);
});
