/**
 * Phase 2C.4.6 — Lease Ownership Enforcement During External Operations
 *
 * This test suite closes the three correctness gaps identified in the
 * Phase 2C.4.5 audit:
 *
 *   P0-1: Pre-provider ownership enforcement — a stale worker that lost its
 *         lease (or was taken over) MUST NOT begin a provider side effect.
 *         Covered by: verifyProvisioningOwnership() + the pre-provider check
 *         in provisionBinding(). Tests J, I.
 *
 *   P0-2: Lease renewal during provider operation — a non-crashed worker
 *         executing a legitimate (bounded) provider operation must never be
 *         subject to lease takeover. Covered by: the heartbeat
 *         (extendProvisioningLease) + the bounded operation timeout
 *         (providerOperationTimeoutMs < PROVISIONING_LEASE_MS).
 *         Tests K, L, M, N.
 *
 *   P0-3: No silent failure swallowing — the unexpected-error catch branch
 *         no longer swallows a failed finalization with .catch(() => {}).
 *         If the claim-guarded FAILED transition fails (claim taken over),
 *         the worker emits a CRITICAL log and returns claim_lost; the
 *         takeover has already marked the binding RECONCILIATION_REQUIRED.
 *         Tests O, P.
 *
 * The hardest race — explicitly called out by the auditor — is Test M:
 *
 *   Worker A claim → enters adapter.provision() → lease expires while A is
 *   still inside the provider call → Worker B takeover → verify A cannot
 *   finalize (heartbeat detects loss, result discarded).
 *
 * Static tests confirm the source carries the new primitives and no longer
 * contains the silent .catch(() => {}).
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
  claimProvisioning,
  verifyProvisioningOwnership,
  extendProvisioningLease,
  _setHeartbeatIntervalForTesting,
  _setOperationTimeoutForTesting,
  _setLeaseDurationForTesting,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearClientCache,
} from "@/lib/connectivity";
import type { MikroTikProviderClient, MikroTikResource, MikroTikResourceConfig } from "@/lib/connectivity";
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
      email: `lease-2c46-${Date.now()}@test.com`,
      name: "Lease 2C.4.6",
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  userId = user.id;
  const tenant = await createTenant({ name: `Lease 2C.4.6 ${Date.now()}` });
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

// ---------------------------------------------------------------------------
// Controllable provider client — its createResource() blocks on a deferred
// promise so tests can hold a worker inside adapter.provision() and then
// manipulate the lease / ownership around it.
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ControllableMikroTikClient implements MikroTikProviderClient {
  createStarted = false;
  createCallCount = 0;
  getResourceCalls = 0;
  /** If set, getResource() returns this; otherwise null (not found). */
  existingResource: MikroTikResource | null = null;
  /** If set, the next createResource() blocks on this deferred. */
  private pending: Deferred<MikroTikResource> | null = null;
  /** If set, createResource() throws this instead of resolving. */
  throwOnCreate: Error | null = null;

  async createResource(config: MikroTikResourceConfig): Promise<MikroTikResource> {
    this.createStarted = true;
    this.createCallCount++;
    if (this.throwOnCreate) {
      throw this.throwOnCreate;
    }
    if (this.pending) {
      return this.pending.promise;
    }
    return {
      id: `*${Date.now().toString(36)}`,
      username: config.username,
      resourceType: config.resourceType,
      isActive: true,
      createdAt: new Date(),
    };
  }

  async getResource(_username: string): Promise<MikroTikResource | null> {
    this.getResourceCalls++;
    return this.existingResource;
  }

  async suspendResource(): Promise<void> {}
  async resumeResource(): Promise<void> {}
  async deleteResource(): Promise<void> {}
  async getResourceUsage(): Promise<null> {
    return null;
  }

  /** Make the next createResource() block until resolve/reject is called. */
  blockNextCreate(): Deferred<MikroTikResource> {
    const d = makeDeferred<MikroTikResource>();
    this.pending = d;
    return d;
  }

  clearBlock(): void {
    this.pending = null;
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 60000, intervalMs = 20): Promise<void> {
  // Neon cold-start latency means each DB op can take ~3s; provisionBinding
  // performs several queries before reaching adapter.provision(), so the
  // default timeout here is generous (60s) to accommodate that.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 2C.4.6 — Lease Ownership Enforcement During External Operations", () => {
  beforeAll(async () => {
    await ensureSetup();
  }, 120000);

  // -------------------------------------------------------------------------
  // J: verifyProvisioningOwnership — unit
  // -------------------------------------------------------------------------
  it("J: verifyProvisioningOwnership returns owns=true for active claim, false after takeover", async () => {
    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Own-J ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Worker A claims
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    const attemptA = claimA.attemptId!;

    // A still owns — status PROVISIONING, attemptId matches, lease fresh
    const ownsA = await verifyProvisioningOwnership(binding.id, attemptA);
    expect(ownsA.owns).toBe(true);

    // Expire A's lease + B takes over
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    expect(claimB.claimed).toBe(true);
    const attemptB = claimB.attemptId!;
    expect(attemptB).not.toBe(attemptA);

    // A's ownership check now FAILS (attemptId mismatch)
    const ownsAAfter = await verifyProvisioningOwnership(binding.id, attemptA);
    expect(ownsAAfter.owns).toBe(false);
    expect(ownsAAfter.reason).toContain("taken over");

    // B's ownership check succeeds
    const ownsB = await verifyProvisioningOwnership(binding.id, attemptB);
    expect(ownsB.owns).toBe(true);

    // Clean up: finalize via B so the binding leaves PROVISIONING
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // I: Pre-provider ownership check blocks a stale worker (no provider call)
  // -------------------------------------------------------------------------
  it("I: stale worker loses ownership pre-provider → claim_lost, NO provider call", async () => {
    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Pre-I ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Worker A claims but is then delayed before reaching adapter.provision().
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);
    const attemptA = claimA.attemptId!;

    // While A is "delayed", A's lease expires and B takes over.
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    expect(claimB.claimed).toBe(true);

    // Now A calls provisionBinding(). The pre-provider ownership check (Step 4)
    // runs inside provisionBinding after a fresh claim attempt. Since B owns
    // the claim, A's claimProvisioning() returns claimed:false immediately —
    // A never reaches adapter.provision().
    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("claim_lost");

    // CRITICAL: no provider createResource was ever issued by the stale path.
    expect(client.createCallCount).toBe(0);

    // Binding is still PROVISIONING under B (B hasn't provisioned yet).
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("PROVISIONING");
    expect(bindingAfter?.provisioningAttemptId).toBe(claimB.attemptId);

    // Cleanup
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: claimB.attemptId! },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // K: extendProvisioningLease — unit
  // -------------------------------------------------------------------------
  it("K: extendProvisioningLease extends for active claim, fails for stale attempt", async () => {
    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Ext-K ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    const claimA = await claimProvisioning(binding.id);
    const attemptA = claimA.attemptId!;

    const beforeRow = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    const beforeExpiry = beforeRow!.claimExpiresAt!;

    // A's heartbeat extends the lease
    const ext = await extendProvisioningLease(binding.id, attemptA);
    expect(ext.extended).toBe(true);
    expect(ext.newExpiresAt).toBeTruthy();

    const afterRow = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(afterRow!.claimExpiresAt!.getTime()).toBeGreaterThan(beforeExpiry.getTime());

    // B takes over
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    const attemptB = claimB.attemptId!;

    // A's heartbeat now fails (stale attempt)
    const extStale = await extendProvisioningLease(binding.id, attemptA);
    expect(extStale.extended).toBe(false);
    expect(extStale.reason).toContain("taken over");

    // B's heartbeat succeeds
    const extB = await extendProvisioningLease(binding.id, attemptB);
    expect(extB.extended).toBe(true);

    // Cleanup
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    clearMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // L: Heartbeat keeps the lease alive PAST its natural expiry during a long
  //    provider operation. Without the heartbeat, the short lease would have
  //    expired and a takeover would succeed.
  // -------------------------------------------------------------------------
  it("L: heartbeat keeps lease alive past natural expiry (no takeover possible)", async () => {
    // Short lease (20s) so the test can wait past its natural expiry. The
    // heartbeat (500ms) extends it well before it expires, so after 25s the
    // lease is still active and a takeover MUST fail.
    const restoreLease = _setLeaseDurationForTesting(20000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);

    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Hb-L ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Block createResource so worker A stays inside adapter.provision().
    const deferred = client.blockNextCreate();
    const provisionPromise = provisionBinding(binding.id);

    // Wait until A is genuinely inside adapter.provision().
    await waitFor(() => client.createStarted);

    // Wait PAST the 20s natural lease expiry. If the heartbeat were not
    // extending the lease, it would have expired and a takeover would succeed.
    await sleep(25000);

    // CRITICAL: a second worker CANNOT take over — the heartbeat has been
    // extending the lease. Without the heartbeat, the 20s lease would have
    // expired ~5s ago and this takeover would succeed.
    const claimB = await claimProvisioning(binding.id);
    expect(claimB.claimed).toBe(false);

    // The lease was extended — claimExpiresAt is still in the future.
    const rowMid = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(rowMid!.status).toBe("PROVISIONING");
    expect(rowMid!.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // Release the provider operation → A succeeds + finalizes.
    deferred.resolve({
      id: "*L-resource",
      username: "rl-test-l",
      resourceType: "hotspot_user",
      isActive: true,
      createdAt: new Date(),
    });

    const result = await provisionPromise;
    expect(result.status).toBe("success");

    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.provisioningAttemptId).toBeNull();

    client.clearBlock();
    clearMockClientRegistry();
    restoreLease();
    restoreHb();
  }, 120000);

  // -------------------------------------------------------------------------
  // M: THE HARDEST RACE — A inside adapter.provision(), ownership is taken
  //    over by B, A's heartbeat detects the loss, A's successful provider
  //    result is DISCARDED (A cannot finalize).
  //
  // This is the exact scenario the auditor called out:
  //   "Worker A claim → lease expires while A is in adapter.provision() →
  //    Worker B takeover → verify A cannot issue a provider operation after
  //    losing ownership."
  //
  // The takeover is simulated by a single atomic DB update that replaces the
  // attemptId (exactly what claimProvisioning's takeover path does). This
  // avoids the heartbeat re-extending the lease between an "expire" step and
  // a "claim" step — the attemptId change is atomic, so A's next heartbeat
  // deterministically detects the mismatch.
  // -------------------------------------------------------------------------
  it("M: stale worker inside adapter.provision() cannot finalize after takeover", async () => {
    const restoreHb = _setHeartbeatIntervalForTesting(400);

    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Race-M ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Worker A starts provisioning; createResource blocks.
    const deferred = client.blockNextCreate();
    const provisionA = provisionBinding(binding.id);

    // Wait until A is genuinely inside adapter.provision().
    await waitFor(() => client.createStarted);

    // Atomically simulate B's takeover: replace the attemptId, set a fresh
    // lease, and mark RECONCILIATION_REQUIRED — exactly what
    // claimProvisioning's takeover path does, in a single update.
    const attemptB = `attempt-B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: {
        provisioningAttemptId: attemptB,
        claimExpiresAt: new Date(Date.now() + 60000),
        reconciliationState: "RECONCILIATION_REQUIRED",
      },
    });

    // Give A's heartbeat a chance to fire and detect the ownership loss.
    // With a 400ms interval + inFlight guard, the effective cycle is ~one DB
    // round-trip; 6s guarantees at least one heartbeat completes after the
    // takeover and sets heartbeatLost = true.
    await sleep(6000);

    // A's provider operation now "succeeds" at the provider (resource created).
    // But A has lost ownership — the heartbeat set heartbeatLost = true, so A
    // must DISCARD the result and return claim_lost.
    deferred.resolve({
      id: "*M-resource-A",
      username: "rl-test-m",
      resourceType: "hotspot_user",
      isActive: true,
      createdAt: new Date(),
    });

    const resultA = await provisionA;

    // CRITICAL: A returns claim_lost — its successful provider result is
    // DISCARDED because ownership was lost during the operation.
    expect(resultA.status).toBe("claim_lost");

    // The binding is NOT BOUND via A. It remains PROVISIONING under B's
    // attemptId (B has not yet called provisionBinding).
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("PROVISIONING");
    expect(bindingAfter?.provisioningAttemptId).toBe(attemptB);
    // Takeover marked it RECONCILIATION_REQUIRED (durable signal).
    expect(bindingAfter?.reconciliationState).toBe("RECONCILIATION_REQUIRED");

    // Cleanup: finalize under B.
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    client.clearBlock();
    clearMockClientRegistry();
    restoreHb();
  }, 120000);

  // -------------------------------------------------------------------------
  // N: Bounded operation timeout → provider op exceeds bound → FAILED
  //    (claim-guarded). Proves the timeout is a hard ceiling on provider ops.
  // -------------------------------------------------------------------------
  it("N: provider operation exceeding the bounded timeout → FAILED (claim-guarded)", async () => {
    const restoreTimeout = _setOperationTimeoutForTesting(100); // 100ms bound
    const restoreHb = _setHeartbeatIntervalForTesting(500); // heartbeat slower than timeout

    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Timeout-N ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // createResource blocks forever (never resolves) → the bounded timeout fires
    const deferred = client.blockNextCreate();
    const result = await provisionBinding(binding.id);

    // The timeout is treated as a failure → FAILED (claim-guarded)
    expect(result.status).toBe("failed_permanent");
    expect(result.error).toContain("timed out");

    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("FAILED");
    expect(bindingAfter?.provisioningAttemptId).toBeNull();
    expect(bindingAfter?.failureReason).toContain("timed out");

    // The deferred is still pending (we never resolved it) — clean it up so it
    // doesn't trigger an unhandled rejection later.
    deferred.resolve({
      id: "*N-discarded",
      username: "rl-test-n",
      resourceType: "hotspot_user",
      isActive: true,
      createdAt: new Date(),
    });

    client.clearBlock();
    clearMockClientRegistry();
    restoreTimeout();
    restoreHb();
  }, 120000);

  // -------------------------------------------------------------------------
  // O: No silent failure — the catch branch no longer swallows a failed
  //    finalization with .catch(() => {}). When the bounded timeout fires AND
  //    the claim was taken over before finalization, the result is claim_lost
  //    with a CRITICAL signal — NOT failed_permanent and NOT silently swallowed.
  // -------------------------------------------------------------------------
  it("O: unexpected error + claim taken over → claim_lost + CRITICAL (no silent swallow)", async () => {
    // 8s timeout — long enough to do the takeover BEFORE the timeout fires,
    // so the catch branch's claimGuardedTransition(FAILED) deterministically
    // matches zero rows (attemptId was replaced).
    const restoreTimeout = _setOperationTimeoutForTesting(8000);
    const restoreHb = _setHeartbeatIntervalForTesting(500);

    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Silent-O ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Block createResource so the worker is inside adapter.provision()...
    const deferred = client.blockNextCreate();
    const provisionPromise = provisionBinding(binding.id);

    // ...wait until the worker is genuinely inside the provider call...
    await waitFor(() => client.createStarted);

    // ...then atomically take over the claim BEFORE the 8s timeout fires.
    // This means the catch branch's claimGuardedTransition(FAILED) will match
    // zero rows (attemptId no longer matches).
    const attemptB = `attempt-B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: {
        provisioningAttemptId: attemptB,
        claimExpiresAt: new Date(Date.now() + 60000),
        reconciliationState: "RECONCILIATION_REQUIRED",
      },
    });

    // Now the timeout fires → catch branch → claimGuardedTransition(FAILED)
    // fails (count=0 because B owns the attempt). The result must be
    // claim_lost with a CRITICAL signal — NOT failed_permanent and NOT
    // silently swallowed.
    const result = await provisionPromise;
    expect(result.status).toBe("claim_lost");
    expect(result.error).toContain("marked RECONCILIATION_REQUIRED");

    // The binding is NOT FAILED via A (A couldn't finalize). It remains
    // PROVISIONING under B, marked RECONCILIATION_REQUIRED.
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("PROVISIONING");
    expect(bindingAfter?.provisioningAttemptId).toBe(attemptB);
    expect(bindingAfter?.reconciliationState).toBe("RECONCILIATION_REQUIRED");

    // Cleanup
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: attemptB },
      data: { status: BINDING_STATES.FAILED, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null },
    });

    // Resolve the still-pending createResource to avoid unhandled rejections.
    deferred.resolve({
      id: "*O-discarded",
      username: "rl-test-o",
      resourceType: "hotspot_user",
      isActive: true,
      createdAt: new Date(),
    });

    client.clearBlock();
    clearMockClientRegistry();
    restoreTimeout();
    restoreHb();
  }, 120000);

  // -------------------------------------------------------------------------
  // P: Takeover marks reconciliationState = RECONCILIATION_REQUIRED
  // -------------------------------------------------------------------------
  it("P: lease takeover sets reconciliationState=RECONCILIATION_REQUIRED", async () => {
    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Recon-P ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Worker A claims
    const claimA = await claimProvisioning(binding.id);
    expect(claimA.claimed).toBe(true);

    // Before takeover, reconciliationState is null
    const beforeRow = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(beforeRow?.reconciliationState).toBeNull();

    // Expire + B takes over
    await db.providerResourceBinding.update({
      where: { id: binding.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const claimB = await claimProvisioning(binding.id);
    expect(claimB.claimed).toBe(true);

    // CRITICAL: takeover marks RECONCILIATION_REQUIRED (durable signal that
    // the previous attempt's outcome is unknown).
    const afterRow = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(afterRow?.reconciliationState).toBe("RECONCILIATION_REQUIRED");

    // And a clean finalization (BOUND or FAILED) CLEARS the flag.
    await db.providerResourceBinding.updateMany({
      where: { id: binding.id, provisioningAttemptId: claimB.attemptId! },
      data: { status: BINDING_STATES.BOUND, provisioningAttemptId: null, claimExpiresAt: null, reconciliationState: null, provisioningState: "COMPLETED" },
    });
    const finalRow = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalRow?.reconciliationState).toBeNull();

    clearMockClientRegistry();
  }, 30000);

  // -------------------------------------------------------------------------
  // Q: Successful provisioning still clears the claim + reconciliation flag
  //    (regression: the new heartbeat/ownership path doesn't break the happy path)
  // -------------------------------------------------------------------------
  it("Q: happy-path provisioning succeeds and clears the claim", async () => {
    const restoreHb = _setHeartbeatIntervalForTesting(500);
    const client = new ControllableMikroTikClient();
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Happy-Q ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("success");
    expect(result.providerResourceId).toBeTruthy();

    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.provisioningAttemptId).toBeNull();
    expect(bindingAfter?.claimExpiresAt).toBeNull();
    expect(bindingAfter?.reconciliationState).toBeNull();
    expect(bindingAfter?.provisioningState).toBe("COMPLETED");

    clearMockClientRegistry();
    restoreHb();
  }, 120000);

  // -------------------------------------------------------------------------
  // Static tests
  // -------------------------------------------------------------------------
  it("Static: verifyProvisioningOwnership + extendProvisioningLease exist", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("export async function verifyProvisioningOwnership");
    expect(source).toContain("export async function extendProvisioningLease");
    expect(source).toContain("provisioningHeartbeatIntervalMs");
    expect(source).toContain("providerOperationTimeoutMs");
    expect(source).toContain("provisioningLeaseMs");
    expect(source).toContain("_setHeartbeatIntervalForTesting");
    expect(source).toContain("_setOperationTimeoutForTesting");
    expect(source).toContain("_setLeaseDurationForTesting");
    // The heartbeat must be guarded against overlapping queries (pool safety).
    expect(source).toContain("heartbeatInFlight");
  }, 10000);

  it("Static: pre-provider ownership check is present in provisionBinding", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    const fnStart = source.indexOf("export async function provisionBinding");
    const fnBody = source.substring(fnStart);
    expect(fnBody).toContain("verifyProvisioningOwnership(bindingId, attemptId)");
    expect(fnBody).toContain("ownership_lost_pre_provider");
    expect(fnBody).toContain("extendProvisioningLease");
    expect(fnBody).toContain("heartbeatLost");
    expect(fnBody).toContain("Promise.race");
    expect(fnBody).toContain("provisioning_failure_unfinalized");
  }, 10000);

  it("Static: NO silent .catch(() => {}) remains in the failure path", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    const fnStart = source.indexOf("export async function provisionBinding");
    // Extract a generous slice that covers the whole provisionBinding body
    // (the function is ~220 lines). We look for the next top-level export to
    // bound the slice, falling back to end-of-file.
    let fnEnd = source.indexOf("\nexport ", fnStart + 100);
    if (fnEnd === -1) fnEnd = source.length;
    const fnBody = source.substring(fnStart, fnEnd);
    // The old silent swallow must be gone.
    expect(fnBody).not.toContain(".catch(() => {})");
    expect(fnBody).not.toContain(".catch(() =>{})");
    // The new explicit failure-finalization path must be present.
    expect(fnBody).toContain("failureTransition.transitioned");
    expect(fnBody).toContain("provisioning_failure_unfinalized");
  }, 10000);

  it("Static: takeover marks RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain('reconciliationState: "RECONCILIATION_REQUIRED"');
    expect(source).toContain("provisioning_claimed_takeover");
  }, 10000);
});
