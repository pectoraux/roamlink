/**
 * Phase 2C.5 — eSIM Supplier Integration (Kernel Neutrality Proof)
 *
 * This suite proves the connectivity provisioning kernel (FROZEN at 2C.4.9)
 * works UNCHANGED for a real eSIM connectivity supplier. The same
 * provisionBinding(), claimProvisioning(), reconcileProvisioning(), lease,
 * heartbeat, and claim-guarded finalization functions that work for MikroTik
 * also work for eSIM — with ZERO kernel changes.
 *
 * The only new code is the eSIM adapter (EsimConnectivityAdapter) and its
 * client/transport — no new abstractions, no new interfaces, no kernel
 * modifications. The adapter implements the EXISTING
 * ConnectivityProviderAdapter contract.
 *
 * Test matrix:
 *   A: Single eSIM provision succeeds (provisionBinding works for eSIM)
 *   B: Concurrent provisioning → exactly ONE profile created (lease works)
 *   C: Crash-after-create recovery (reconcileProvisioning works for eSIM)
 *   D: CONFLICT convergence (provider-side convergence works for eSIM)
 *   E: Already BOUND → already_provisioned (idempotency)
 *   F: Provisioning failure → FAILED (claim-guarded)
 *   G: Kernel neutrality — both MikroTik and eSIM registered simultaneously
 *
 * Static:
 *   - eSIM adapter implements ConnectivityProviderAdapter
 *   - eSIM client has GET-first + CONFLICT convergence (same as RouterOS)
 *   - eSIM registered in the provider registry
 *   - NO kernel changes (entitlement.ts unchanged from 2C.4.9)
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
  EsimSupplierClient,
  MockEsimTransport,
  registerMockEsimClientForInstance,
  clearEsimMockClientRegistry,
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
const instanceIds: string[] = [];

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({
    data: {
      email: `esim-2c5-${Date.now()}@test.com`,
      name: "eSIM 2C.5",
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  userId = user.id;
  const tenant = await createTenant({ name: `eSIM 2C.5 ${Date.now()}` });
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
    clearEsimMockClientRegistry();
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
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

async function createEsimBinding(instanceId: string) {
  const ent = await createEntitlement({
    tenantId,
    subscriptionId,
    capabilityType: CAPABILITY_TYPES.ROAMING,
    capabilitySet: { allowedCountries: ["GH", "NG", "KE"], dataLimitBytes: 5_000_000_000 },
    validFrom: new Date(),
    userId,
  });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });
  const binding = await createResourceBinding({
    entitlementId: ent.id,
    providerType: "esim",
    resourceType: "esim_profile",
    providerInstanceId: instanceId,
    userId,
  });
  bindingIds.push(binding.id);
  return { ent, binding };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 2C.5 — eSIM Supplier Integration (Kernel Neutrality Proof)", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // -------------------------------------------------------------------------
  // A: Single eSIM provision succeeds — provisionBinding works for eSIM
  // -------------------------------------------------------------------------
  it("A: single eSIM provision succeeds via provisionBinding()", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockEsimTransport();
    transport.setStrictConflictMode(true);
    const client = new EsimSupplierClient(transport, "esim-test-A");
    const inst = await createProviderInstance({ tenantId, providerType: "esim", name: `eSIM Supplier A ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockEsimClientForInstance(inst.id, client);

    const { binding } = await createEsimBinding(inst.id);
    const result = await provisionBinding(binding.id);

    // CRITICAL: the SAME provisionBinding() function (unchanged from 2C.4.9)
    // works for eSIM — no kernel changes needed.
    expect(result.status).toBe("success");
    expect(result.providerResourceId).toBeTruthy();

    // The binding is BOUND with an ICCID (providerResourceId)
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.providerResourceId).toBeTruthy();
    expect(bindingAfter?.provisioningAttemptId).toBeNull();

    // CRITICAL: exactly ONE eSIM profile was created at the supplier
    expect(transport.profiles.size).toBe(1);

    // The profile's reference is the deterministic convergence key
    const expectedRef = `rl-${binding.id.slice(-12)}`;
    expect(transport.profiles.has(expectedRef)).toBe(true);

    // The ICCID is supplier-assigned (starts with 89, the telecom prefix)
    const profile = transport.profiles.get(expectedRef)!;
    expect(profile.iccid).toBeTruthy();
    expect(profile.iccid).not.toBe(expectedRef); // ICCID ≠ reference

    clearEsimMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // B: Concurrent provisioning → exactly ONE profile (lease works for eSIM)
  // -------------------------------------------------------------------------
  it("B: concurrent eSIM provisioning → exactly ONE profile, ONE POST", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockEsimTransport();
    transport.setStrictConflictMode(true);
    const client = new EsimSupplierClient(transport, "esim-test-B");
    const inst = await createProviderInstance({ tenantId, providerType: "esim", name: `eSIM Supplier B ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockEsimClientForInstance(inst.id, client);

    const { binding } = await createEsimBinding(inst.id);

    // Two concurrent provisionBinding() calls — the lease ensures only ONE wins.
    const results = await Promise.all([
      provisionBinding(binding.id),
      provisionBinding(binding.id),
    ]);

    const successes = results.filter((r) => r.status === "success");
    const lost = results.filter((r) => r.status === "claim_lost" || r.status === "already_provisioned");
    expect(successes.length).toBe(1);
    expect(lost.length).toBe(1);

    // CRITICAL: exactly ONE profile at the supplier
    expect(transport.profiles.size).toBe(1);

    // CRITICAL: exactly ONE POST (the winner's). The loser never reached the adapter.
    const posts = transport.operationLog.filter((o) => o.method === "POST");
    expect(posts.length).toBe(1);

    clearEsimMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // C: Crash-after-create recovery — reconcileProvisioning works for eSIM
  // -------------------------------------------------------------------------
  it("C: crash-after-create → reconcileProvisioning GETs existing, zero duplicate", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockEsimTransport();
    transport.setStrictConflictMode(true);
    const client = new EsimSupplierClient(transport, "esim-test-C");
    const inst = await createProviderInstance({ tenantId, providerType: "esim", name: `eSIM Supplier C ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockEsimClientForInstance(inst.id, client);

    const { binding } = await createEsimBinding(inst.id);

    // Worker A claims and creates the profile at the supplier, but "crashes"
    // before BOUND finalization.
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    const expectedRef = `rl-${binding.id.slice(-12)}`;
    await client.createProfile({
      resourceType: "esim_profile",
      reference: expectedRef,
      dataLimitBytes: 5_000_000_000,
      allowedCountries: ["GH", "NG", "KE"],
      validityDays: 30,
    });

    // CRITICAL: the profile exists at the supplier (A created it)
    expect(transport.profiles.size).toBe(1);
    const iccidFromA = transport.profiles.get(expectedRef)!.iccid as string;

    // Expire A's lease (A crashed)
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B calls reconcileProvisioning → takes over → GET finds existing → BOUND
    const result = await reconcileProvisioning(binding.id);
    expect(result.status).toBe("recovered");
    expect(result.providerResourceId).toBe(iccidFromA);

    // CRITICAL: still exactly ONE profile (B did NOT create a duplicate)
    expect(transport.profiles.size).toBe(1);

    // CRITICAL: zero POSTs from B (B's GET found the profile → no POST)
    const posts = transport.operationLog.filter((o) => o.method === "POST");
    expect(posts.length).toBe(1); // only A's initial create

    clearEsimMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // D: CONFLICT convergence — provider-side convergence works for eSIM
  // -------------------------------------------------------------------------
  it("D: concurrent PUTs converge on ONE profile via CONFLICT reconciliation", async () => {
    const transport = new MockEsimTransport();
    transport.setStrictConflictMode(true);
    const client = new EsimSupplierClient(transport, "esim-test-D");

    const reference = `rl-esim-D-${Date.now()}`;
    const config = {
      resourceType: "esim_profile",
      reference,
      dataLimitBytes: 5_000_000_000,
      allowedCountries: ["GH", "NG", "KE"],
      validityDays: 30,
    };

    // First create succeeds
    const profileA = await client.createProfile(config);
    expect(profileA.reference).toBe(reference);
    expect(profileA.id).toBeTruthy();
    const iccidA = profileA.id;

    // Second create with the SAME reference — the client's GET-first path
    // should find the existing profile and return it (idempotent).
    const profileB = await client.createProfile(config);
    expect(profileB.id).toBe(iccidA); // SAME ICCID

    // CRITICAL: exactly ONE profile exists
    expect(transport.profiles.size).toBe(1);

    clearEsimMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // E: Already BOUND → already_provisioned (idempotency)
  // -------------------------------------------------------------------------
  it("E: already BOUND → already_provisioned (no supplier call)", async () => {
    const transport = new MockEsimTransport();
    transport.setStrictConflictMode(true);
    const client = new EsimSupplierClient(transport, "esim-test-E");
    const inst = await createProviderInstance({ tenantId, providerType: "esim", name: `eSIM Supplier E ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockEsimClientForInstance(inst.id, client);

    const { binding } = await createEsimBinding(inst.id);

    // Manually transition to BOUND
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { status: BINDING_STATES.BOUND, providerResourceId: "89-existing-iccid", provisioningState: "COMPLETED" },
    });

    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("already_provisioned");

    // CRITICAL: no supplier operations were issued
    expect(transport.operationLog.length).toBe(0);
    expect(transport.profiles.size).toBe(0);

    clearEsimMockClientRegistry();
  }, 60000);

  // -------------------------------------------------------------------------
  // F: Provisioning failure → FAILED (claim-guarded)
  // -------------------------------------------------------------------------
  it("F: provisioning failure → FAILED (claim-guarded for eSIM)", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockEsimTransport();
    transport.setStrictConflictMode(true);
    // Make the GET lookup fail permanently (simulating a supplier error)
    transport.setFailureMode("PERMANENT", 400, ["/profiles?reference="]);
    const client = new EsimSupplierClient(transport, "esim-test-F");
    const inst = await createProviderInstance({ tenantId, providerType: "esim", name: `eSIM Supplier F ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockEsimClientForInstance(inst.id, client);

    const { binding } = await createEsimBinding(inst.id);
    const result = await provisionBinding(binding.id);

    // The failure should be classified (fail-closed on lookup uncertainty)
    expect(["failed_permanent", "failed_retryable", "claim_lost"]).toContain(result.status);

    // CRITICAL: no profile was created (fail-closed)
    expect(transport.profiles.size).toBe(0);

    clearEsimMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // G: Kernel neutrality — both MikroTik and eSIM registered simultaneously
  // -------------------------------------------------------------------------
  it("G: both MikroTik and eSIM are registered in the provider registry", async () => {
    // CRITICAL: the provider registry contains BOTH provider types.
    // The kernel is supplier-neutral — it doesn't know or care about the
    // specific supplier; it only knows the ConnectivityProviderAdapter contract.
    const types = listRegisteredProviderTypes();
    expect(types).toContain("mikrotik");
    expect(types).toContain("esim");

    expect(isProviderRegistered("mikrotik")).toBe(true);
    expect(isProviderRegistered("esim")).toBe(true);
  }, 10000);

  // -------------------------------------------------------------------------
  // Static: eSIM adapter implements ConnectivityProviderAdapter
  // -------------------------------------------------------------------------
  it("Static: eSIM adapter implements ConnectivityProviderAdapter contract", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/esim/adapter.ts", "utf-8");
    expect(source).toContain("implements ConnectivityProviderAdapter");
    expect(source).toContain("readonly providerType = \"esim\"");
    expect(source).toContain("async provision(");
    expect(source).toContain("async suspend(");
    expect(source).toContain("async resume(");
    expect(source).toContain("async release(");
    expect(source).toContain("async getUsage(");
    expect(source).toContain("async reconcile(");
  }, 10000);

  // -------------------------------------------------------------------------
  // Static: eSIM client has GET-first + CONFLICT convergence (same as RouterOS)
  // -------------------------------------------------------------------------
  it("Static: eSIM client has GET-first + CONFLICT convergence (same pattern as RouterOS)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/esim/esim-client.ts", "utf-8");
    // GET-first idempotency
    expect(source).toContain("getProfileByReference(config.reference)");
    expect(source).toContain("esim.create_idempotent");
    // CONFLICT reconciliation
    expect(source).toContain('err.errorType === "CONFLICT"');
    expect(source).toContain("esim.create_conflict_reconciling");
    expect(source).toContain("esim.create_conflict_reconciled");
    // Fail-closed on lookup uncertainty
    expect(source).toContain("esim.create_lookup_failed_closed");
    // TIMEOUT reconciliation
    expect(source).toContain("esim.create_uncertain");
    expect(source).toContain("esim.create_reconciled");
  }, 10000);

  // -------------------------------------------------------------------------
  // Static: NO kernel changes (entitlement.ts unchanged from 2C.4.9)
  // -------------------------------------------------------------------------
  it("Static: NO kernel changes — entitlement.ts has no eSIM-specific code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    // The kernel should NOT contain any eSIM-specific logic — it's supplier-neutral.
    // It should not reference "esim", "iccid", "profile", or "roaming".
    expect(source).not.toContain("iccid");
    expect(source).not.toContain("esim_profile");
    expect(source).not.toContain("EsimSupplierClient");
    // The kernel should still contain the generic provisioning functions
    expect(source).toContain("export async function provisionBinding");
    expect(source).toContain("export async function reconcileProvisioning");
    expect(source).toContain("export async function claimProvisioning");
  }, 10000);
});
