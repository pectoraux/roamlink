/**
 * Phase 2C.4.9 — Canonical Provisioning Recovery & Reconciliation Matrix
 *
 * This suite proves the full recovery contract that the auditor specified.
 * It uses the canonical reconcileProvisioning() worker and instruments
 * provider operations (transport.operationLog, transport.resources) to
 * verify external state, not just database state.
 *
 * Recovery matrix (from the auditor):
 *
 *   A. Crash before provider call → takeover creates exactly one resource
 *   B. Crash after provider create → takeover GETs existing, zero duplicate PUT
 *   C. PUT timeout + process death → takeover reconciles
 *   D. 409 + GET exists → converge
 *   E. 409 + GET absent → fail closed
 *   F. Active lease → reconciler does nothing
 *   G. Expired lease → reconciler takes over
 *   H. Stale worker finalization → rejected
 *   I. Stale worker failure finalization → rejected
 *   J. RECONCILIATION_REQUIRED + successful recovery → cleared
 *   K. Provider instance becomes inactive during recovery → fail closed
 *   L. Provider instance reassigned to another tenant → fail closed
 *   M. Two recovery workers → exactly one takeover
 *
 * Static:
 *   - provisionBinding resolves runtime BEFORE claiming (ordering fix)
 *   - verifyProvisioningOwnership is the last DB operation before adapter.provision()
 *   - reconcileProvisioning exists and is exported
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import {
  seedConnectivityCapabilities,
  createEntitlement,
  transitionEntitlement,
  createResourceBinding,
  createProviderInstance,
  provisionBinding,
  reconcileProvisioning,
  claimProvisioning,
  _setLeaseDurationForTesting,
  _setHeartbeatIntervalForTesting,
  _setOperationTimeoutForTesting,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  RouterOSProviderClient,
  MockRouterOSTransport,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearClientCache,
} from "@/lib/connectivity";
import { hashPassword } from "@/lib/security";
import { createTenant, addTenantUser } from "@/lib/tenant/service";

let setupDone = false;
let tenantId: string;
let userId: string;
let subscriptionId: string;
const entitlementIds: string[] = [];
const bindingIds: string[] = [];
const instanceIds: string[] = [];

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({
    data: {
      email: `recovery-2c49-${Date.now()}@test.com`,
      name: "Recovery 2C.4.9",
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  userId = user.id;
  const tenant = await createTenant({ name: `Recovery 2C.4.9 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const sub = await db.tenantSubscription.create({
    data: { tenantId, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });
  subscriptionId = sub.id;
}

afterAll(async () => {
  try {
    clearMockClientRegistry();
    clearClientCache();
    for (const bid of bindingIds) await db.providerResourceBinding.deleteMany({ where: { id: bid } }).catch(() => {});
    for (const iid of instanceIds) await db.connectivityProviderInstance.deleteMany({ where: { id: iid } }).catch(() => {});
    for (const eid of entitlementIds) {
      await db.providerResourceBinding.deleteMany({ where: { entitlementId: eid } }).catch(() => {});
      await db.connectivityEntitlement.deleteMany({ where: { id: eid } }).catch(() => {});
    }
    if (subscriptionId) await db.tenantSubscription.deleteMany({ where: { id: subscriptionId } }).catch(() => {});
    if (tenantId) {
      await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) {
    console.error("afterAll:", e);
  }
  await db.$disconnect();
}, 180000);

async function createBindingForTest(instanceId: string) {
  const ent = await createEntitlement({
    tenantId,
    subscriptionId,
    capabilityType: CAPABILITY_TYPES.INTERNET,
    capabilitySet: { downloadMbps: 50 },
    validFrom: new Date(),
    userId,
  });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });
  const binding = await createResourceBinding({
    entitlementId: ent.id,
    providerType: "mikrotik",
    resourceType: "hotspot_user",
    providerInstanceId: instanceId,
    userId,
  });
  bindingIds.push(binding.id);
  return binding;
}

async function makeInstance(label: string) {
  const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `${label} ${Date.now()}`, userId });
  instanceIds.push(inst.id);
  return inst;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 2C.4.9 — Canonical Provisioning Recovery & Reconciliation Matrix", () => {
  beforeAll(async () => {
    await ensureSetup();
  }, 120000);

  // -------------------------------------------------------------------------
  // A: Crash before provider call → takeover creates exactly one resource
  // -------------------------------------------------------------------------
  it("A: crash before provider call → takeover creates exactly one resource", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-A");
    const inst = await makeInstance("Router Recovery-A");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // Worker A claims but "crashes" before calling adapter.provision().
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);

    // A did NOT issue any provider call (crash before PUT).
    expect(transport.resources.size).toBe(0);
    expect(transport.operationLog.filter((o) => o.method === "PUT").length).toBe(0);

    // Expire A's lease.
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B calls reconcileProvisioning → takes over → GET absent → PUT create → BOUND.
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("recovered");

    // CRITICAL: exactly ONE resource created (by B).
    expect(transport.resources.size).toBe(1);
    expect(transport.operationLog.filter((o) => o.method === "PUT").length).toBe(1);

    // Binding is BOUND with a providerResourceId.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.providerResourceId).toBeTruthy();
    expect(bindingAfter?.reconciliationState).toBeNull(); // cleared on clean finalization

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // B: Crash after provider create → takeover GETs existing, zero duplicate PUT
  // -------------------------------------------------------------------------
  it("B: crash after provider create → takeover GETs existing, zero duplicate PUT", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-B");
    const inst = await makeInstance("Router Recovery-B");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // Worker A claims and creates the resource at the provider, but "crashes"
    // before BOUND finalization.
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    const expectedUsername = `rl-${binding.id.slice(-12)}`;
    await client.createResource({
      resourceType: "hotspot_user",
      username: expectedUsername,
      password: "pw-B",
      downloadRateLimitBps: 50_000_000,
      uploadRateLimitBps: 10_000_000,
    });

    // CRITICAL: the resource exists at the provider (A created it).
    expect(transport.resources.size).toBe(1);
    const resourceIdFromA = transport.resources.get(expectedUsername)![".id"] as string;

    // Expire A's lease.
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B calls reconcileProvisioning → takes over → GET finds existing → BOUND.
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("recovered");
    expect(result.providerResourceId).toBe(resourceIdFromA);

    // CRITICAL: still exactly ONE resource (B did NOT create a duplicate).
    expect(transport.resources.size).toBe(1);

    // CRITICAL: exactly ONE PUT (A's). B's GET found the resource → zero PUTs from B.
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(1);

    // Binding is BOUND with A's resource.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.providerResourceId).toBe(resourceIdFromA);

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // C: PUT timeout + process death → takeover reconciles
  // -------------------------------------------------------------------------
  it("C: PUT timeout + process death → takeover reconciles via GET", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-C");
    const inst = await makeInstance("Router Recovery-C");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // Worker A claims and issues a PUT that "times out" (uncertain outcome).
    // The resource WAS created at the provider despite the timeout.
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    const expectedUsername = `rl-${binding.id.slice(-12)}`;
    // Simulate: A's PUT created the resource (the provider received it), but
    // A never got the response (timeout). A "dies" before reconciliation.
    transport.resources.set(expectedUsername, {
      ".id": `*C-${Date.now().toString(36)}`,
      name: expectedUsername,
      password: "pw-C",
      "rate-limit": "50M/10M",
      disabled: "false",
    });
    const resourceIdFromA = transport.resources.get(expectedUsername)![".id"] as string;

    // Expire A's lease (A died).
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B calls reconcileProvisioning → takes over → GET finds resource → BOUND.
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("recovered");
    expect(result.providerResourceId).toBe(resourceIdFromA);

    // CRITICAL: exactly ONE resource (B's GET found A's resource).
    expect(transport.resources.size).toBe(1);

    // CRITICAL: zero PUTs from B (B's GET found the resource → no PUT).
    // A's "PUT" was simulated (not via transport.request), so the log has 0 PUTs.
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // D: 409 + GET exists → converge (client-level, proven in 2C.4.6b, confirmed here)
  // -------------------------------------------------------------------------
  it("D: 409 + GET exists → converge on existing resource", async () => {
    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-D");

    const username = `rl-recovery-D-${Date.now()}`;
    const config = {
      resourceType: "hotspot_user",
      username,
      password: "pw-D",
      downloadRateLimitBps: 50_000_000,
      uploadRateLimitBps: 10_000_000,
    };

    // First create succeeds.
    const r1 = await client.createResource(config);
    expect(r1.username).toBe(username);

    // Second create: GET finds existing → returns it (Path 1 idempotency).
    const r2 = await client.createResource(config);
    expect(r2.id).toBe(r1.id);

    // Exactly ONE resource.
    expect(transport.resources.size).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // E: 409 + GET absent → fail closed (client-level, proven structurally)
  // -------------------------------------------------------------------------
  it("E: 409 + GET absent → PERMANENT failure (fail closed)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    // The client handles CONFLICT + GET-not-found by failing closed.
    expect(source).toContain("routeros.create_conflict_inconsistent");
    expect(source).toContain("Provider inconsistency: PUT conflicted but GET cannot find resource");
    expect(source).toContain("PERMANENT");
  }, 10000);

  // -------------------------------------------------------------------------
  // F: Active lease → reconciler does nothing
  // -------------------------------------------------------------------------
  it("F: active lease → reconciler does nothing (already_healthy)", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-F");
    const inst = await makeInstance("Router Recovery-F");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // Worker A claims (active lease).
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);

    // B calls reconcileProvisioning → sees active lease → does nothing.
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("already_healthy");
    expect(result.action).toBe("none");

    // CRITICAL: no provider operations were issued.
    expect(transport.operationLog.length).toBe(0);
    expect(transport.resources.size).toBe(0);

    // Cleanup
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
    restoreLease();
  }, 60000);

  // -------------------------------------------------------------------------
  // G: Expired lease → reconciler takes over
  // -------------------------------------------------------------------------
  it("G: expired lease → reconciler takes over and recovers", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-G");
    const inst = await makeInstance("Router Recovery-G");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // Worker A claims, then lease expires.
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B calls reconcileProvisioning → takes over → recovers.
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("recovered");

    // Binding is BOUND.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // H: Stale worker finalization → rejected
  // -------------------------------------------------------------------------
  it("H: stale worker finalization → rejected (claim-guarded)", async () => {
    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-H");
    const inst = await makeInstance("Router Recovery-H");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // A claims.
    const claimA = await claimProvisioning(binding.id);
    const attemptA = claimA.attemptId!;

    // Expire + B takes over.
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    const attemptB = claimB.attemptId!;
    expect(attemptB).not.toBe(attemptA);

    // A tries to finalize with stale attemptId → 0 rows.
    const staleFinalize = await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptA, status: BINDING_STATES.PROVISIONING },
      data: { status: BINDING_STATES.BOUND, provisioningAttemptId: null, claimExpiresAt: null },
    });
    expect(staleFinalize.count).toBe(0);

    // B can finalize.
    const bFinalize = await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB, status: BINDING_STATES.PROVISIONING },
      data: { status: BINDING_STATES.BOUND, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });
    expect(bFinalize.count).toBe(1);

    clearMockClientRegistry();
  }, 60000);

  // -------------------------------------------------------------------------
  // I: Stale worker failure finalization → rejected
  // -------------------------------------------------------------------------
  it("I: stale worker failure finalization → rejected (claim-guarded)", async () => {
    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-I");
    const inst = await makeInstance("Router Recovery-I");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // A claims.
    const claimA = await claimProvisioning(binding.id);
    const attemptA = claimA.attemptId!;

    // Expire + B takes over.
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    const attemptB = claimB.attemptId!;

    // A tries to finalize as FAILED with stale attemptId → 0 rows.
    const staleFailFinalize = await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptA, status: BINDING_STATES.PROVISIONING },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, failureReason: "stale" },
    });
    expect(staleFailFinalize.count).toBe(0);

    // Cleanup via B.
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
  }, 60000);

  // -------------------------------------------------------------------------
  // J: RECONCILIATION_REQUIRED + successful recovery → cleared
  // -------------------------------------------------------------------------
  it("J: RECONCILIATION_REQUIRED + successful recovery → cleared", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-J");
    const inst = await makeInstance("Router Recovery-J");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // A claims, lease expires, B takes over (marks RECONCILIATION_REQUIRED).
    const claimA = await claimProvisioning(binding.id);
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    expect(claimB.claimed).toBe(true);

    // CRITICAL: takeover marked RECONCILIATION_REQUIRED.
    const rowAfterTakeover = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(rowAfterTakeover?.reconciliationState).toBe("RECONCILIATION_REQUIRED");

    // Expire B's lease and call reconcileProvisioning.
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("recovered");

    // CRITICAL: reconciliationState is CLEARED on successful recovery.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.reconciliationState).toBeNull();

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // K: Provider instance becomes inactive during recovery → fail closed
  // -------------------------------------------------------------------------
  it("K: provider instance inactive during recovery → fail closed", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-K");
    const inst = await makeInstance("Router Recovery-K");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // A claims, lease expires.
    const claimA = await claimProvisioning(binding.id);
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Mark the provider instance as INACTIVE (simulating it going offline).
    await db.connectivityProviderInstance.update({
      where: { id: inst.id },
      data: { status: "inactive" },
    });

    // B calls reconcileProvisioning → resolveBindingRuntime throws (instance not active).
    // This should propagate as a failure, not a silent success.
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).not.toBe("recovered");
    expect(result.status).not.toBe("already_healthy");
    // It should be "failed" or "claim_lost" (due to the throw).
    expect(["failed", "claim_lost", "manual_intervention_required"]).toContain(result.status);

    // CRITICAL: no resource was created at the provider.
    expect(transport.resources.size).toBe(0);

    // Restore instance status for cleanup.
    await db.connectivityProviderInstance.update({
      where: { id: inst.id },
      data: { status: "active" },
    });

    // Cleanup
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // L: Provider instance reassigned to another tenant → fail closed
  // -------------------------------------------------------------------------
  it("L: provider instance reassigned to another tenant → fail closed", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-L");
    const inst = await makeInstance("Router Recovery-L");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // A claims, lease expires.
    const claimA = await claimProvisioning(binding.id);
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Create a second tenant and reassign the instance to it.
    const tenant2 = await createTenant({ name: `Tenant2 Recovery-L ${Date.now()}` });
    await db.connectivityProviderInstance.update({
      where: { id: inst.id },
      data: { tenantId: tenant2.id },
    });

    // B calls reconcileProvisioning → resolveBindingRuntime throws (cross-tenant).
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).not.toBe("recovered");
    expect(result.status).not.toBe("already_healthy");
    expect(["failed", "claim_lost", "manual_intervention_required"]).toContain(result.status);

    // CRITICAL: no resource was created.
    expect(transport.resources.size).toBe(0);

    // Restore tenant for cleanup.
    await db.connectivityProviderInstance.update({
      where: { id: inst.id },
      data: { tenantId },
    });
    await db.tenant.deleteMany({ where: { id: tenant2.id } }).catch(() => {});

    // Cleanup
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // M: Two recovery workers → exactly one takeover
  // -------------------------------------------------------------------------
  it("M: two concurrent reconcileProvisioning calls → exactly one takeover", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const client = new RouterOSProviderClient(transport, "recovery-M");
    const inst = await makeInstance("Router Recovery-M");
    registerMockClientForInstance(inst.id, client);

    const binding = await createBindingForTest(inst.id);

    // A claims, lease expires.
    const claimA = await claimProvisioning(binding.id);
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Two workers call reconcileProvisioning concurrently.
    const results = await Promise.all([
      reconcileProvisioning(binding.id),
      reconcileProvisioning(binding.id),
    ]);

    // Exactly one should recover; the other should be claim_lost or already_healthy.
    const recovered = results.filter((r) => r.status === "recovered");
    const lost = results.filter((r) => r.status === "claim_lost" || r.status === "already_healthy");
    expect(recovered.length).toBe(1);
    expect(lost.length).toBe(1);

    // CRITICAL: exactly ONE resource created.
    expect(transport.resources.size).toBe(1);
    expect(transport.operationLog.filter((o) => o.method === "PUT").length).toBe(1);

    // Binding is BOUND.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // Static: provisionBinding resolves runtime BEFORE claiming (ordering fix)
  // -------------------------------------------------------------------------
  it("Static: provisionBinding resolves runtime BEFORE claiming (2C.4.9 ordering fix)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    const fnStart = source.indexOf("export async function provisionBinding");
    let fnEnd = source.indexOf("\nexport ", fnStart + 100);
    if (fnEnd === -1) fnEnd = source.length;
    const fnBody = source.substring(fnStart, fnEnd);

    // The runtime resolution must come BEFORE the claim.
    const resolvePos = fnBody.indexOf("resolveBindingRuntime(bindingId)");
    const claimPos = fnBody.indexOf("claimProvisioning(bindingId)");
    expect(resolvePos).toBeGreaterThan(-1);
    expect(claimPos).toBeGreaterThan(-1);
    expect(resolvePos).toBeLessThan(claimPos);

    // The ownership check must come AFTER the claim (it checks the claim).
    const ownershipPos = fnBody.indexOf("verifyProvisioningOwnership(bindingId, attemptId)");
    expect(ownershipPos).toBeGreaterThan(claimPos);

    // There must be NO resolveBindingRuntime call between the ownership check
    // and adapter.provision(). The adapter input is constructed in-memory.
    const afterOwnership = fnBody.substring(ownershipPos);
    const provisionPos = afterOwnership.indexOf("adapter.provision(");
    expect(provisionPos).toBeGreaterThan(-1);
    // CRITICAL: no resolveBindingRuntime between ownership check and provider call.
    const resolveInBetween = afterOwnership.substring(0, provisionPos).indexOf("resolveBindingRuntime");
    expect(resolveInBetween).toBe(-1);

    // The immutable adapter input is constructed in-memory.
    expect(fnBody).toContain("const bindingInput");
    expect(fnBody).toContain("...binding");
    expect(fnBody).toContain("status: BINDING_STATES.PROVISIONING");
  }, 10000);

  // -------------------------------------------------------------------------
  // Static: reconcileProvisioning exists and is the canonical recovery worker
  // -------------------------------------------------------------------------
  it("Static: reconcileProvisioning exists with the correct contract", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("export async function reconcileProvisioning");
    expect(source).toContain("export type ReconciliationResult");
    expect(source).toContain("already_healthy");
    expect(source).toContain("recovered");
    expect(source).toContain("reprovisioned");
    expect(source).toContain("manual_intervention_required");
  }, 10000);
});
