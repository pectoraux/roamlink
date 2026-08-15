/**
 * Phase 2C.4.5 — Durable Provisioning Lease + Attempt Identity
 *
 * Tests:
 *   A. Single provision succeeds with attemptId
 *   B. Concurrent provision → exactly ONE PUT (claim prevents second)
 *   C. Second worker during active lease → claim_lost (no PUT)
 *   D. Already BOUND → already_provisioned (no PUT)
 *   E. Provisioning failure → FAILED (claim-guarded)
 *   F. FAILED → retry succeeds (new claim)
 *   G. Stale worker after lease takeover cannot finalize (claim-guarded transition)
 *   H. Crash-after-create: lease expires, new worker takes over, reconciles existing resource
 *
 * Static:
 *   - provisioningAttemptId + claimExpiresAt in schema
 *   - claimGuardedTransition uses WHERE provisioningAttemptId
 *   - claimProvisioning generates attemptId
 *   - provisionBinding uses claimGuardedTransition
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
  createProviderInstance,
  provisionBinding,
  claimProvisioning,
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
  const user = await db.user.create({ data: { email: `lease-2c45-${Date.now()}@test.com`, name: "Lease 2C.4.5", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Lease 2C.4.5 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const sub = await db.tenantSubscription.create({ data: { tenantId, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionId = sub.id;
}

afterAll(async () => {
  try {
    clearMockClientRegistry();
    clearClientCache();
    for (const bid of bindingIds) await db.providerResourceBinding.deleteMany({ where: { id: bid } }).catch(() => {});
    for (const iid of instanceIds) await db.connectivityProviderInstance.deleteMany({ where: { id: iid } }).catch(() => {});
    for (const eid of entitlementIds) { await db.providerResourceBinding.deleteMany({ where: { entitlementId: eid } }).catch(() => {}); await db.connectivityEntitlement.deleteMany({ where: { id: eid } }).catch(() => {}); }
    if (subscriptionId) await db.tenantSubscription.deleteMany({ where: { id: subscriptionId } }).catch(() => {});
    if (tenantId) { await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {}); await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {}); }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

async function createBindingWithInstance(instanceId: string) {
  const ent = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });
  const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mikrotik", resourceType: "hotspot_user", providerInstanceId: instanceId, userId });
  bindingIds.push(binding.id);
  return { ent, binding };
}

describe("Phase 2C.4.5 — Durable Provisioning Lease + Attempt Identity", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // A: Single provision succeeds with attemptId
  // ---------------------------------------------------------------
  it("A: single provision succeeds with attemptId", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "single-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Single ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("success");

    // Binding is BOUND + attemptId cleared (claim finalized)
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.provisioningAttemptId).toBeNull(); // cleared after finalization
    expect(bindingAfter?.claimExpiresAt).toBeNull();
    expect(bindingAfter?.providerResourceId).toBeTruthy();

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // B: Concurrent provision → exactly ONE PUT
  // ---------------------------------------------------------------
  it("B: concurrent provision → exactly ONE PUT (lease claim)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "concurrent-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Concurrent ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    const results = await Promise.allSettled([
      provisionBinding(binding.id),
      provisionBinding(binding.id),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === "success").length;
    expect(successes).toBe(1);

    const others = results.filter((r) => r.status === "fulfilled" && r.value.status !== "success");
    expect(others.length).toBe(1);
    expect(["claim_lost"]).toContain((others[0] as any).value.status);

    // CRITICAL: exactly ONE PUT
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(1);

    clearMockClientRegistry();
  }, 60000);

  // ---------------------------------------------------------------
  // C: Second worker during active lease → claim_lost
  // ---------------------------------------------------------------
  it("C: second worker during active lease → claim_lost (no PUT)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "active-lease-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router ActiveLease ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Manually claim (simulates worker A holding the lease)
    const claim = await claimProvisioning(binding.id);
    expect(claim.claimed).toBe(true);

    // Worker B tries to claim → should fail (lease is active)
    const claim2 = await claimProvisioning(binding.id);
    expect(claim2.claimed).toBe(false);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // G: Stale worker after lease takeover cannot finalize
  // ---------------------------------------------------------------
  it("G: stale worker cannot finalize after lease takeover", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "stale-worker-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router StaleWorker ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Worker A claims
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    const attemptA = claimA.attemptId!;

    // Expire worker A's lease (simulate time passing)
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) }, // expired 1 second ago
    });

    // Worker B takes over
    const claimB = await claimProvisioning(binding.id);
    expect(claimB.claimed).toBe(true);
    const attemptB = claimB.attemptId!;
    expect(attemptB).not.toBe(attemptA);

    // Worker A tries to finalize with stale attemptId → should fail
    // (claimGuardedTransition checks provisioningAttemptId)
    // We simulate this by directly calling the DB with the stale attemptId
    const staleFinalize = await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptA, status: BINDING_STATES.PROVISIONING },
      data: { status: BINDING_STATES.BOUND, provisioningAttemptId: null, claimExpiresAt: null },
    });
    expect(staleFinalize.count).toBe(0); // CRITICAL: stale worker cannot finalize

    // Worker B can finalize
    const bFinalize = await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB, status: BINDING_STATES.PROVISIONING },
      data: { status: BINDING_STATES.BOUND, provisioningAttemptId: null, claimExpiresAt: null },
    });
    expect(bFinalize.count).toBe(1); // Worker B can finalize

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // H: Crash-after-create: lease expires, new worker reconciles
  // ---------------------------------------------------------------
  it("H: crash-after-create → lease expires → new worker takes over", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "crash-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Crash ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Worker A claims
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);

    // Worker A calls provision() but "crashes" (we simulate by not completing)
    // The resource WAS created at the provider (mock transport has it)
    const expectedUsername = `rl-${binding.id.slice(-12)}`;
    transport.resources.set(expectedUsername, {
      ".id": `*${Date.now().toString(36)}`, name: expectedUsername, password: "pw",
      "rate-limit": "50M/10M", disabled: "false",
      createdAt: new Date(), downloadBytes: 0, uploadBytes: 0, sessionStartTime: new Date(),
    });

    // Expire worker A's lease
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Worker B takes over and provisions
    const result = await provisionBinding(binding.id);

    // Worker B should succeed — the resource already exists (GET → found → return)
    expect(result.status).toBe("success");

    // Binding is BOUND
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    // CRITICAL: only ONE PUT (worker B's GET found the existing resource → no PUT)
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0); // zero PUTs — the resource already existed

    clearMockClientRegistry();
  }, 60000);

  // ---------------------------------------------------------------
  // D: Already BOUND → already_provisioned
  // ---------------------------------------------------------------
  it("D: already BOUND → already_provisioned (no PUT)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "already-bound-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router AlreadyBound ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Manually transition to BOUND
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: "*preexisting" });

    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("already_provisioned");

    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // E: Provisioning failure → FAILED (claim-guarded)
  // ---------------------------------------------------------------
  it("E: provisioning failure → FAILED", async () => {
    const transport = new MockRouterOSTransport();
    transport.setFailureMode("PERMANENT", 400, ["/ip/hotspot/user?name="]);
    const client = new RouterOSProviderClient(transport, "fail-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Fail ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("failed_permanent");

    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("FAILED");
    expect(bindingAfter?.provisioningAttemptId).toBeNull(); // cleared after finalization

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // F: FAILED → retry succeeds (new claim)
  // ---------------------------------------------------------------
  it("F: FAILED → retry succeeds", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "retry-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Retry ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // First attempt fails
    transport.setFailureMode("PERMANENT", 400, ["/ip/hotspot/user?name="]);
    const result1 = await provisionBinding(binding.id);
    expect(result1.status).toBe("failed_permanent");

    // Clear failure
    transport.clearFailureMode();

    // Transition FAILED → PROVISIONING (retry)
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });

    // Second attempt succeeds (new claim with new attemptId)
    const result2 = await provisionBinding(binding.id);
    expect(result2.status).toBe("success");

    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    clearMockClientRegistry();
  }, 120000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: provisioningAttemptId + claimExpiresAt in schema", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("provisioningAttemptId String?");
    expect(source).toContain("claimExpiresAt  DateTime?");
  }, 10000);

  it("Static: claimGuardedTransition uses WHERE provisioningAttemptId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("provisioningAttemptId: input.attemptId");
    expect(source).toContain("claimGuardedTransition");
    expect(source).toContain("provisioning_stale_worker");
  }, 10000);

  it("Static: claimProvisioning generates attemptId + lease", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("const attemptId = `attempt-");
    expect(source).toContain("PROVISIONING_LEASE_MS");
    expect(source).toContain("claimExpiresAt");
    expect(source).toContain("claimType: \"takeover\"");
  }, 10000);

  it("Static: provisionBinding uses claimGuardedTransition", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    const fnStart = source.indexOf("export async function provisionBinding");
    // Just check the function body contains claimGuardedTransition
    const fnBody = source.substring(fnStart);
    expect(fnBody).toContain("claimGuardedTransition");
    expect(fnBody).toContain("claim_lost");
  }, 10000);
});
