/**
 * Phase 2C.4.7 — Genuine Concurrent Provisioning/Conflict Harness
 *
 * This suite addresses the auditor's critique of Phase 2C.4.6b: the prior
 * convergence tests (R, S) simulated the race with direct transport calls
 * and manual DB mutations rather than running two REAL workers
 * concurrently. This suite runs genuine concurrent workers.
 *
 * Three tests, each exercising a different concurrency dimension:
 *
 * V — Real concurrent PUT race in the CLIENT (no lease, no kernel):
 *     Two real `RouterOSProviderClient.createResource()` calls run
 *     concurrently against the same transport. The GET gate ensures both
 *     workers observe "absent" before either issues a PUT. Both issue PUT.
 *     The first creates the resource; the second gets CONFLICT (409) and
 *     reconciles via GET → bind. Both return the SAME providerResourceId.
 *     Exactly ONE external resource exists. No duplicate.
 *
 * W — Two real concurrent `provisionBinding()` workers:
 *     `Promise.all([provisionBinding(id), provisionBinding(id)])` against a
 *     single binding. The lease ensures only ONE worker wins the claim and
 *     issues a PUT. The loser gets claim_lost (or already_provisioned if the
 *     winner finished first). Exactly ONE external resource, ONE PUT, ONE
 *     BOUND transition.
 *
 * X — Stale worker overlapping live `provisionBinding()` (the hardest race):
 *     Worker A's real `provisionBinding()` is running, blocked inside
 *     adapter.provision() AFTER the PUT has created the resource at the
 *     provider (PUT-create pause). A's lease expires (short test lease).
 *     Worker B's real `provisionBinding()` takes over, GET finds A's
 *     resource, B finalizes to BOUND. A is released, tries to finalize →
 *     claim_guarded transition fails (B already finalized) → claim_lost.
 *     Exactly ONE resource, ONE PUT, ONE BOUND, stale A cannot overwrite.
 *
 * These tests instrument PROVIDER state (transport.operationLog,
 * transport.resources) — not just database state.
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
  _setHeartbeatIntervalForTesting,
  _setOperationTimeoutForTesting,
  _setLeaseDurationForTesting,
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
      email: `harness-2c47-${Date.now()}@test.com`,
      name: "Harness 2C.4.7",
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  userId = user.id;
  const tenant = await createTenant({ name: `Harness 2C.4.7 ${Date.now()}` });
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

async function createBindingWithInstance(instanceId: string) {
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
  return { ent, binding };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 2C.4.7 — Genuine Concurrent Provisioning/Conflict Harness", () => {
  beforeAll(async () => {
    await ensureSetup();
  }, 120000);

  // -------------------------------------------------------------------------
  // V: Real concurrent PUT race in the CLIENT (no lease, no kernel).
  //
  // Two REAL RouterOSProviderClient.createResource() calls run concurrently
  // against the same transport. The GET gate ensures both observe "absent"
  // before either issues a PUT. Both issue PUT. The first creates the
  // resource; the second gets CONFLICT (409) → GET → bind. Both return the
  // SAME providerResourceId. Exactly ONE external resource.
  // -------------------------------------------------------------------------
  it("V: two real concurrent createResource() calls converge on ONE resource via CONFLICT", async () => {
    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    transport.armGetGate(); // both GETs will block until released

    const client = new RouterOSProviderClient(transport, "harness-V");

    const username = `rl-harness-V-${Date.now()}`;
    const config = {
      resourceType: "hotspot_user",
      username,
      password: "pw-V",
      downloadRateLimitBps: 50_000_000,
      uploadRateLimitBps: 10_000_000,
    };

    // Launch TWO REAL createResource() calls concurrently. Both will:
    //   1. GET by username → blocked on the gate
    //   2. (after release) GET returns [] (absent)
    //   3. PUT — first creates, second CONFLICT
    //   4. Second client: CONFLICT → GET → finds resource → returns it
    const promiseA = client.createResource(config);
    const promiseB = client.createResource(config);

    // Wait until BOTH workers are blocked on the GET gate.
    await transport.waitForGetGateCount(2);
    expect(transport.gatePendingCount).toBe(2);

    // Release the gate — both GETs resolve to "absent" simultaneously.
    transport.releaseGetGate();

    // Both workers now race to PUT. With strictConflictMode, one creates and
    // the other gets CONFLICT → reconciles via GET.
    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    // CRITICAL: both workers return a resource with the SAME id.
    expect(resA.username).toBe(username);
    expect(resB.username).toBe(username);
    expect(resA.id).toBe(resB.id);
    expect(resA.id).toBeTruthy();

    // CRITICAL: exactly ONE external resource exists at the provider.
    expect(transport.resources.size).toBe(1);
    expect(transport.resources.has(username)).toBe(true);

    // CRITICAL: exactly TWO PUTs were attempted (both workers issued PUT).
    // The first created the resource; the second got CONFLICT.
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(2);

    // CRITICAL: the reconciliation GET was issued by the second worker
    // (after the CONFLICT). Total GETs: 2 (gated, initial) + 1 (reconciliation).
    const gets = transport.operationLog.filter((o) => o.method === "GET");
    expect(gets.length).toBe(3);

    clearMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // W: Two real concurrent provisionBinding() workers.
  //
  // Promise.all([provisionBinding(id), provisionBinding(id)]) against a
  // single binding. The lease ensures only ONE worker wins the claim and
  // issues a PUT. The loser gets claim_lost (or already_provisioned if the
  // winner finished first). Exactly ONE external resource, ONE PUT, ONE
  // BOUND transition.
  // -------------------------------------------------------------------------
  it("W: two real concurrent provisionBinding() calls → ONE resource, ONE PUT, ONE BOUND", async () => {
    const restoreLease = _setLeaseDurationForTesting(60000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const restoreTimeout = _setOperationTimeoutForTesting(60000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);

    const client = new RouterOSProviderClient(transport, "harness-W");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Harness-W ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Launch TWO REAL provisionBinding() calls concurrently.
    const results = await Promise.all([
      provisionBinding(binding.id),
      provisionBinding(binding.id),
    ]);

    // The lease ensures only ONE worker wins. The other gets claim_lost
    // (if they raced) or already_provisioned (if the winner finished first).
    const successes = results.filter((r) => r.status === "success");
    const lostOrAlready = results.filter((r) => r.status === "claim_lost" || r.status === "already_provisioned");

    expect(successes.length).toBe(1);
    expect(lostOrAlready.length).toBe(1);

    // CRITICAL: no worker reported a failure.
    const failures = results.filter((r) => r.status === "failed_permanent" || r.status === "failed_retryable");
    expect(failures.length).toBe(0);

    // CRITICAL: exactly ONE external resource at the provider.
    expect(transport.resources.size).toBe(1);

    // CRITICAL: exactly ONE PUT was issued (the winner's). The loser never
    // reached adapter.provision().
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(1);

    // CRITICAL: the binding is BOUND with a providerResourceId.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.providerResourceId).toBeTruthy();
    expect(bindingAfter?.provisioningAttemptId).toBeNull();

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 120000);

  // -------------------------------------------------------------------------
  // X: Stale worker overlapping live provisionBinding() — the hardest race.
  //
  // Worker A's REAL provisionBinding() is running, blocked inside
  // adapter.provision() AFTER the PUT has created the resource at the
  // provider (PUT-create pause). A's lease expires (short test lease).
  // Worker B's REAL provisionBinding() takes over, GET finds A's resource,
  // B finalizes to BOUND. A is released, tries to finalize → claim-guarded
  // transition fails (B already finalized) → claim_lost.
  //
  // Exactly ONE resource, ONE PUT, ONE BOUND, stale A cannot overwrite.
  // -------------------------------------------------------------------------
  it("X: stale provisionBinding() worker cannot finalize after takeover by real B", async () => {
    // Lease (20s) must be long enough for A to reach adapter.provision()
    // through Neon-latency DB operations (~12s: claim + ownership check +
    // re-resolve + GET + PUT), but short enough to expire during the test.
    // Heartbeat (120s) is set longer than the entire test so it NEVER fires
    // before B takes over — the claim-guarded finalization (not the heartbeat)
    // is what catches A. Timeout (120s) must not fire during the test.
    const restoreLease = _setLeaseDurationForTesting(20000);
    const restoreHb = _setHeartbeatIntervalForTesting(120000);
    const restoreTimeout = _setOperationTimeoutForTesting(120000);

    const transport = new MockRouterOSTransport();
    transport.setStrictConflictMode(true);
    const pauseHandle = transport.armPutCreatePause();

    const client = new RouterOSProviderClient(transport, "harness-X");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Harness-X ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // --- Worker A: real provisionBinding() ---
    // A claims, passes the pre-provider ownership check, starts the heartbeat,
    // enters adapter.provision(), the client does GET (absent) → PUT (creates
    // resource) → BLOCKS (put-create pause). The resource now EXISTS at the
    // provider, but A's createResource hasn't returned yet.
    const provisionA = provisionBinding(binding.id);

    // Wait until A's PUT has created the resource at the provider.
    await pauseHandle.putCreated;

    // CRITICAL: the resource exists at the provider (A created it).
    expect(transport.resources.size).toBe(1);

    // Wait for A's lease to expire (20s lease). A claimed at ~t=6 (after Neon
    // latency), so the lease expires at ~t=26. We sleep 25s after putCreated
    // (which fires at ~t=18) to reach ~t=43, well past the expiry. The
    // heartbeat (120s) never fires during the test, so the lease is NOT
    // extended — it expires naturally.
    await sleep(25000);

    // --- Worker B: real provisionBinding() ---
    // B's claimProvisioning sees the expired lease → takeover. B gets a new
    // attemptId. B passes the pre-provider ownership check. B enters
    // adapter.provision(): GET by username → FINDS the resource A created →
    // returns it (NO PUT). B finalizes to BOUND via claim-guarded transition.
    const resultB = await provisionBinding(binding.id);
    expect(resultB.status).toBe("success");
    expect(resultB.providerResourceId).toBeTruthy();

    // CRITICAL: the binding is now BOUND (B finalized).
    const bindingAfterB = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfterB?.status).toBe("BOUND");
    expect(bindingAfterB?.providerResourceId).toBeTruthy();
    expect(bindingAfterB?.provisioningAttemptId).toBeNull();

    // CRITICAL: still exactly ONE resource at the provider (B did NOT create
    // a duplicate — B's GET found A's resource).
    expect(transport.resources.size).toBe(1);

    // CRITICAL: exactly ONE PUT (A's). B issued ZERO PUTs.
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(1);

    // --- Release A's blocked PUT ---
    // A's createResource finally returns. A's provisionBinding checks
    // heartbeatLost (the heartbeat may have fired by now, detecting the loss)
    // and/or proceeds to claim-guarded finalization. Either way, A cannot
    // finalize — B already did. A returns claim_lost.
    pauseHandle.release();

    const resultA = await provisionA;

    // CRITICAL: A returns claim_lost — its successful provider result is
    // DISCARDED because ownership was lost (lease expired + B took over).
    expect(resultA.status).toBe("claim_lost");

    // CRITICAL: the binding is STILL BOUND with B's providerResourceId.
    // A did NOT overwrite it.
    const bindingFinal = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingFinal?.status).toBe("BOUND");
    expect(bindingFinal?.providerResourceId).toBe(bindingAfterB?.providerResourceId);

    // CRITICAL: still exactly ONE PUT (A's release did not cause a second PUT).
    const putsFinal = transport.operationLog.filter((o) => o.method === "PUT");
    expect(putsFinal.length).toBe(1);

    // CRITICAL: still exactly ONE resource (no duplicate from A's release).
    expect(transport.resources.size).toBe(1);

    clearMockClientRegistry();
    restoreLease();
    restoreHb();
    restoreTimeout();
  }, 180000);

  // -------------------------------------------------------------------------
  // Static: the concurrency harness features exist on MockRouterOSTransport
  // -------------------------------------------------------------------------
  it("Static: MockRouterOSTransport has GET gate + PUT-create pause", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/transport.ts", "utf-8");
    expect(source).toContain("armGetGate");
    expect(source).toContain("releaseGetGate");
    expect(source).toContain("waitForGetGateCount");
    expect(source).toContain("gatePendingCount");
    expect(source).toContain("armPutCreatePause");
    expect(source).toContain("putCreated");
  }, 10000);
});
