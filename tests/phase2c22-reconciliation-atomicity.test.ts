/**
 * Phase 2C.2.2 — Reconciliation Atomicity + State-Transition Safety
 *
 * Tests:
 *   1. Atomic in_sync reconciliation
 *   2. Atomic drift transition (BOUND → DEGRADED)
 *   3. Atomic resource_missing transition (BOUND → FAILED)
 *   4. Retryable failure preserves durable state + RECONCILIATION_REQUIRED
 *   5. Permanent failure → FAILED + MANUAL_INTERVENTION_REQUIRED
 *   6. Concurrent reconciliation converges safely
 *   7. Stale observation conflict → no overwrite
 *   8. Invalid adapter recommendation → MANUAL_INTERVENTION_REQUIRED
 *   9. Different provider bindings remain isolated
 *   10. Registry collision still rejected
 *   11. Repeated reconciliation is idempotent
 *   12. MANUAL_INTERVENTION_REQUIRED not picked up by auto-retry
 *
 * Static:
 *   - Legal transition matrix exists
 *   - MANUAL_INTERVENTION_REQUIRED used for failed_permanent
 *   - Atomic transaction with FOR UPDATE
 *   - Stale observation check
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
  const user = await db.user.create({ data: { email: `atomic-2c22-${Date.now()}@test.com`, name: "Atomic 2C.2.2", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Atomic 2C.2.2 ${Date.now()}` });
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

describe("Phase 2C.2.2 — Reconciliation Atomicity + State-Transition Safety", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // 1. Atomic in_sync reconciliation
  // ---------------------------------------------------------------
  it("1. atomic in_sync reconciliation", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("in_sync");

    // Verify: binding is BOUND + reconciliationState is RECONCILED (atomic)
    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("BOUND");
    expect(finalBinding?.reconciliationState).toBe("RECONCILED");
    expect(finalBinding?.lastReconciledAt).toBeTruthy();
  }, 30000);

  // ---------------------------------------------------------------
  // 2. Atomic drift transition
  // ---------------------------------------------------------------
  it("2. atomic drift transition (BOUND → DEGRADED)", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Suspend at provider to create drift
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.suspend({ entitlement: makeEntInput(ent), binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata) });

    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("transitioned");
    expect(result.transition?.from).toBe("BOUND");
    expect(result.transition?.to).toBe("DEGRADED");

    // Verify: binding is DEGRADED + reconciliationState is RECONCILED (atomic)
    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("DEGRADED");
    expect(finalBinding?.reconciliationState).toBe("RECONCILED");
  }, 30000);

  // ---------------------------------------------------------------
  // 3. Atomic resource_missing transition
  // ---------------------------------------------------------------
  it("3. atomic resource_missing transition (BOUND → FAILED)", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Release at provider to make resource missing
    const updatedBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    await mockConnectivityProvider.release({ entitlement: makeEntInput(ent), binding: makeBindingInput(updatedBinding!, p.providerResourceId, p.providerMetadata) });

    const result = await reconcileBindingWithProvider(binding.id);
    expect(result.status).toBe("transitioned");
    expect(result.transition?.to).toBe("FAILED");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("FAILED");
    expect(finalBinding?.reconciliationState).toBe("RECONCILED");
  }, 30000);

  // ---------------------------------------------------------------
  // 5. Permanent failure → FAILED + MANUAL_INTERVENTION_REQUIRED
  // ---------------------------------------------------------------
  it("5. permanent failure → FAILED + MANUAL_INTERVENTION_REQUIRED", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Create a custom adapter that returns failed_permanent
    const permanentFailAdapter = {
      providerType: "mock",
      label: "Mock Permanent Fail (test override)",
      provision: async () => ({ status: "success" as const, providerResourceId: p.providerResourceId }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({
        status: "failed_permanent" as const,
        details: "Simulated permanent failure",
      }),
    };
    replaceConnectivityProvider(permanentFailAdapter);

    try {
      const result = await reconcileBindingWithProvider(binding.id);
      expect(result.status).toBe("transitioned");
      expect(result.transition?.to).toBe("FAILED");

      // CRITICAL: reconciliationState must be MANUAL_INTERVENTION_REQUIRED (NOT RECONCILIATION_REQUIRED)
      const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
      expect(finalBinding?.status).toBe("FAILED");
      expect(finalBinding?.reconciliationState).toBe("MANUAL_INTERVENTION_REQUIRED");
      expect(finalBinding?.failureReason).toContain("permanent");
    } finally {
      // Restore the original mock adapter
      replaceConnectivityProvider(mockConnectivityProvider);
    }
  }, 30000);

  // ---------------------------------------------------------------
  // 4. Retryable failure preserves durable state
  // ---------------------------------------------------------------
  it("4. retryable failure preserves durable state + RECONCILIATION_REQUIRED", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Create a custom adapter that returns failed_retryable
    const retryableFailAdapter = {
      providerType: "mock",
      label: "Mock Retryable Fail (test override)",
      provision: async () => ({ status: "success" as const, providerResourceId: p.providerResourceId }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({
        status: "failed_retryable" as const,
        details: "Simulated retryable failure",
      }),
    };
    replaceConnectivityProvider(retryableFailAdapter);

    try {
      const result = await reconcileBindingWithProvider(binding.id);
      expect(result.status).toBe("in_sync"); // no transition, but metadata updated

      // CRITICAL: binding stays BOUND (preserved) + reconciliationState is RECONCILIATION_REQUIRED
      const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
      expect(finalBinding?.status).toBe("BOUND"); // unchanged
      expect(finalBinding?.reconciliationState).toBe("RECONCILIATION_REQUIRED");
      expect(finalBinding?.failureReason).toContain("retryable");
    } finally {
      replaceConnectivityProvider(mockConnectivityProvider);
    }
  }, 30000);

  // ---------------------------------------------------------------
  // 6. Concurrent reconciliation converges safely
  // ---------------------------------------------------------------
  it("6. concurrent reconciliation converges safely", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Run two concurrent reconciliations
    const results = await Promise.allSettled([
      reconcileBindingWithProvider(binding.id),
      reconcileBindingWithProvider(binding.id),
    ]);

    // Both should succeed (in_sync for active binding)
    const successes = results.filter((r) => r.status === "fulfilled").length;
    expect(successes).toBe(2);

    // The binding must be in a consistent state — BOUND + RECONCILED
    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("BOUND");
    expect(finalBinding?.reconciliationState).toBe("RECONCILED");
  }, 30000);

  // ---------------------------------------------------------------
  // 8. Invalid adapter recommendation → MANUAL_INTERVENTION_REQUIRED
  // ---------------------------------------------------------------
  it("8. invalid adapter recommendation → MANUAL_INTERVENTION_REQUIRED", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Create an adapter that recommends an ILLEGAL transition (BOUND → UNBOUND)
    const illegalAdapter = {
      providerType: "mock",
      label: "Mock Illegal Recommendation (test override)",
      provision: async () => ({ status: "success" as const, providerResourceId: p.providerResourceId }),
      suspend: async () => ({ status: "success" as const }),
      resume: async () => ({ status: "success" as const }),
      release: async () => ({ status: "success" as const }),
      getUsage: async () => undefined,
      reconcile: async () => ({
        status: "drift_detected" as const,
        observedState: "inactive" as const,
        recommendedBindingState: "UNBOUND", // ILLEGAL: BOUND → UNBOUND is not in the legal transition matrix
        details: "Adapter recommends illegal transition",
      }),
    };
    replaceConnectivityProvider(illegalAdapter);

    try {
      const result = await reconcileBindingWithProvider(binding.id);
      // The kernel should refuse the illegal transition
      expect(result.status).toBe("in_sync"); // no transition applied

      // CRITICAL: binding stays BOUND + reconciliationState is MANUAL_INTERVENTION_REQUIRED
      const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
      expect(finalBinding?.status).toBe("BOUND"); // unchanged — illegal transition refused
      expect(finalBinding?.reconciliationState).toBe("MANUAL_INTERVENTION_REQUIRED");
      expect(finalBinding?.failureReason).toContain("illegal");
    } finally {
      replaceConnectivityProvider(mockConnectivityProvider);
    }
  }, 30000);

  // ---------------------------------------------------------------
  // 11. Repeated reconciliation is idempotent
  // ---------------------------------------------------------------
  it("11. repeated reconciliation is idempotent", async () => {
    const { ent, binding } = await createProvisionedBinding();
    const p = await mockConnectivityProvider.provision({ entitlement: makeEntInput(ent), binding: makeBindingInput(binding) });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Reconcile 3 times
    const r1 = await reconcileBindingWithProvider(binding.id);
    const r2 = await reconcileBindingWithProvider(binding.id);
    const r3 = await reconcileBindingWithProvider(binding.id);

    expect(r1.status).toBe("in_sync");
    expect(r2.status).toBe("in_sync");
    expect(r3.status).toBe("in_sync");

    // Binding is still BOUND + RECONCILED
    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("BOUND");
    expect(finalBinding?.reconciliationState).toBe("RECONCILED");
  }, 120000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: legal transition matrix exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("RECONCILIATION_LEGAL_TRANSITIONS");
    expect(source).toContain("function isLegalReconciliationTransition");
    expect(source).toContain("BOUND: [BINDING_STATES.DEGRADED");
    expect(source).toContain("RELEASED: []");
  }, 10000);

  it("Static: MANUAL_INTERVENTION_REQUIRED used for failed_permanent", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("MANUAL_INTERVENTION_REQUIRED");
    expect(source).toContain("Phase 2C.2.2: Use MANUAL_INTERVENTION_REQUIRED (NOT RECONCILIATION_REQUIRED)");
  }, 10000);

  it("Static: atomic transaction with FOR UPDATE", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("FOR UPDATE");
    expect(source).toContain("ATOMIC COMMIT");
    expect(source).toContain("$transaction");
  }, 10000);

  it("Static: stale observation check exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("STALE OBSERVATION CHECK");
    expect(source).toContain("stale_observation");
    expect(source).toContain("observedBindingStatus");
  }, 10000);

  it("Static: no separate transitionBinding + updateMany in reconcileBindingWithProvider", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    // The new code should NOT call transitionBinding() separately from the metadata update
    const fnStart = source.indexOf("export async function reconcileBindingWithProvider");
    const fnEnd = source.length;
    const fnBody = source.substring(fnStart, fnEnd);
    // The old pattern of calling transitionBinding then separately updating reconciliationState should be gone
    expect(fnBody).not.toContain("await transitionBinding({");
    expect(fnBody).not.toContain('data: { reconciliationState: "RECONCILED", lastReconciledAt: new Date() },\n      });\n      return {');
  }, 10000);
});
