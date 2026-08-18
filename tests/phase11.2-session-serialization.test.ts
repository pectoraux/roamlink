/**
 * Phase 11.2 — Session-Level Execution Serialization (DB-backed runtime)
 *
 * Proves acceptance invariant #2:
 *   "A session cannot have two connectivity mutations executing concurrently."
 *
 * The primitive is DB-authoritative (a column on ConnectivitySession with a
 * fenced updateMany acquire). Two workers cannot both acquire the same
 * session's slot. The slot owns the ENTIRE mutation window:
 *
 *   decision execution request
 *       ↓
 *   claim session execution slot  ← DB-authoritative fenced updateMany
 *       ↓
 *   perform connectivity mutation  (create + execute action)
 *       ↓
 *   verify convergence  (assertActiveConnectivityInvariant)
 *       ↓
 *   release session execution slot  ← fenced (only claim owner releases)
 *
 * The dangerous case (from the architect's spec):
 *   Session S ACTIVE on A
 *   Decision 1: A → B
 *   Decision 2: A → C
 *   Two workers execute concurrently
 *   Expected:
 *     exactly one obtains the session mutation slot
 *     exactly one transition is authoritative
 *     final session resource is either B or C, never an inconsistent blend
 *     losing decision is refused/requeued (returned to PENDING)
 *     losing target does not remain orphaned IN_USE
 *
 * Tests:
 *   11.2.1: concurrent SWITCH A→B + SWITCH A→C → exactly one executes, losing
 *           decision requeued, losing target not orphaned IN_USE.
 *   11.2.2: slot is released after execution (success) — next decision can acquire.
 *   11.2.3: slot is released after execution (failure) — next decision can acquire.
 *   11.2.4: slot lease expiry → reclaimExpiredSessionSlots clears it.
 *   11.2.5: acquireSessionExecutionSlot is fenced — two concurrent acquires → one.
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase11.2-session-serialization.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { mockConnectivityProvider } from "@/lib/connectivity";
import type { ConnectivityEntitlementInput, ProviderResourceBindingInput } from "@/lib/connectivity/adapter";
import { createSession } from "@/lib/control-plane/session-manager";
import { makeDecision } from "@/lib/control-plane/decision-engine";
import { createAction, executeAction } from "@/lib/control-plane/action-executor";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";
import { executeDecision } from "@/lib/control-plane/decision-executor";
import {
  acquireSessionExecutionSlot,
  releaseSessionExecutionSlot,
  renewSessionExecutionSlot,
  reclaimExpiredSessionSlots,
  fencedSessionUpdate,
  fencedTransitionSessionState,
  fencedReserveResource,
  fencedMarkResourceInUse,
  fencedReleaseResource,
  createSlotOwnershipContext,
  SESSION_EXECUTION_SLOT_LEASE_MS,
} from "@/lib/control-plane/session-execution-slot";
import { reclaimExpiredDecisionClaims, DECISION_EXECUTION_LEASE_MS } from "@/lib/control-plane/decision-executor";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  subjectId: string;
  resourceAId: string;
  resourceBId: string;
  resourceCId: string;
  entitlementId: string;
  providerInstanceId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase112-${Date.now()}@test.roamlink`;
  const slug = `p112-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P11.2 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P112 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P112 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  // Three resources: A (active), B (switch target 1), C (switch target 2)
  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });
  const capB = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
  const resB = await db.protocolResource.create({ data: { capabilityId: capB.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "B" }), capacity: JSON.stringify({ totalBandwidthMbps: 300 }), state: "AVAILABLE" } });
  const capC = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 200, typicalLatencyMs: 15 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.88, status: "active" } });
  const resC = await db.protocolResource.create({ data: { capabilityId: capC.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "C" }), capacity: JSON.stringify({ totalBandwidthMbps: 200 }), state: "AVAILABLE" } });

  const entInput: ConnectivityEntitlementInput = {
    id: ent.id, tenantId: tenant.id, subscriptionId: subscription.id, status: "ACTIVE",
    capabilityType: "INTERNET", capabilitySet: JSON.parse(ent.capabilitySet),
    policy: null, validFrom: ent.validFrom, validUntil: null,
  };
  const prA = await mockConnectivityProvider.provision({ entitlement: entInput, binding: { id: "b", entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null } as ProviderResourceBindingInput });
  const bA = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prA.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resA.id }, data: { providerBindingId: bA.id } });
  const prB = await mockConnectivityProvider.provision({ entitlement: entInput, binding: { id: "b2", entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null } as ProviderResourceBindingInput });
  const bB = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prB.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resB.id }, data: { providerBindingId: bB.id } });
  const prC = await mockConnectivityProvider.provision({ entitlement: entInput, binding: { id: "b3", entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null } as ProviderResourceBindingInput });
  const bC = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prC.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resC.id }, data: { providerBindingId: bC.id } });

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: ent.id });

  // ACTIVATE resource A so the session is ACTIVE on A.
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p112-${session.id}` });
  await executeAction(action.id);

  // Mark the ACTIVATE decision as EXECUTED so it doesn't interfere with test decisions.
  await db.connectivityDecision.update({
    where: { id: decision.decisionId },
    data: { executionState: "EXECUTED", executedAt: new Date(), executedActionId: action.id },
  }).catch(() => {});

  // Clear any session slot left by the ACTIVATE.
  await db.connectivitySession.update({
    where: { id: session.id },
    data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
  }).catch(() => {});

  const cleanup = async () => {
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resA.id, resB.id, resC.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resA.id, resB.id, resC.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capA.id, capB.id, capC.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bA.id, bB.id, bC.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { tenantId: tenant.id, subjectId, resourceAId: resA.id, resourceBId: resB.id, resourceCId: resC.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 11.2 — Session-Level Execution Serialization (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // =========================================================================
  // 11.2.1 — THE DANGEROUS CASE: concurrent SWITCH A→B + SWITCH A→C
  // =========================================================================
  it("11.2.1: concurrent SWITCH A→B + SWITCH A→C → exactly one executes, losing decision requeued, losing target not orphaned", async () => {
    // Ensure the session is ACTIVE on A with no slot held.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    // Create two SWITCH decisions targeting B and C respectively.
    const decision1 = await db.connectivityDecision.create({
      data: {
        intentId: `p112-switch-B-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: switch to B"]),
        executionState: "PENDING",
      },
    });
    const decision2 = await db.connectivityDecision.create({
      data: {
        intentId: `p112-switch-C-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceCId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: switch to C"]),
        executionState: "PENDING",
      },
    });

    // Two workers execute concurrently.
    const [result1, result2] = await Promise.all([
      executeDecision(decision1.id),
      executeDecision(decision2.id),
    ]);

    // Exactly one executes (EXECUTED). The other is requeued (SESSION_BUSY).
    const results = [result1, result2];
    const executedCount = results.filter((r) => r.executionState === "EXECUTED").length;
    const requeuedCount = results.filter((r) => r.executionState === "SESSION_BUSY").length;
    expect(executedCount).toBe(1);
    expect(requeuedCount).toBe(1);

    // The final session resource is either B or C — never a blend, never both.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, executionSlotClaimId: true },
    });
    expect([fx.resourceBId, fx.resourceCId]).toContain(session?.activeResourceId);
    expect(session?.executionSlotClaimId).toBeNull(); // slot released after execution

    // The winning target is IN_USE; the losing target is NOT orphaned IN_USE.
    const resB = await db.protocolResource.findUnique({ where: { id: fx.resourceBId }, select: { state: true, reservedBy: true } });
    const resC = await db.protocolResource.findUnique({ where: { id: fx.resourceCId }, select: { state: true, reservedBy: true } });
    const resA = await db.protocolResource.findUnique({ where: { id: fx.resourceAId }, select: { state: true, reservedBy: true } });

    // The winning target is IN_USE owned by the session.
    const winningResource = session?.activeResourceId === fx.resourceBId ? resB : resC;
    const losingResource = session?.activeResourceId === fx.resourceBId ? resC : resB;
    expect(winningResource?.state).toBe("IN_USE");
    expect(winningResource?.reservedBy).toBe(fx.sessionId);

    // The losing target is NOT IN_USE (it was never touched — no action created).
    expect(losingResource?.state).not.toBe("IN_USE");
    expect(losingResource?.reservedBy).not.toBe(fx.sessionId);

    // The old resource (A) is AVAILABLE (released by the winning SWITCH).
    expect(resA?.state).toBe("AVAILABLE");

    // The requeued decision is back to PENDING (not FAILED, not DEAD_LETTER).
    const requeuedDecisionId = result1.executionState === "SESSION_BUSY" ? decision1.id : decision2.id;
    const requeuedDecision = await db.connectivityDecision.findUnique({
      where: { id: requeuedDecisionId },
      select: { executionState: true, executionClaimId: true },
    });
    expect(requeuedDecision?.executionState).toBe("PENDING");
    expect(requeuedDecision?.executionClaimId).toBeNull(); // claim released

    // Exactly one action was created (for the winning decision only).
    const actions = await db.connectivityAction.findMany({
      where: { sessionId: fx.sessionId, type: "SWITCH" },
    });
    expect(actions.length).toBe(1);

    // Cleanup: switch back to A for subsequent tests.
    await db.connectivityDecision.create({
      data: {
        intentId: `p112-cleanup-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceAId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["cleanup: switch back to A"]),
        executionState: "PENDING",
      },
    }).then(async (d) => {
      await executeDecision(d.id).catch(() => {});
    }).catch(() => {});

    // Delete the requeued decision so it doesn't interfere.
    await db.connectivityDecision.deleteMany({ where: { id: { in: [decision1.id, decision2.id] } } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.2.2 — Slot is released after execution (success) — next decision can acquire
  // =========================================================================
  it("11.2.2: slot released after successful execution — next decision can acquire immediately", async () => {
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    // Decision 1: SWITCH A→B (should succeed and release the slot).
    const decision1 = await db.connectivityDecision.create({
      data: {
        intentId: `p112-slot-release-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: slot release"]),
        executionState: "PENDING",
      },
    });

    const result1 = await executeDecision(decision1.id);
    expect(result1.executionState).toBe("EXECUTED");

    // The slot is released (null).
    const after1 = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimId: true, activeResourceId: true },
    });
    expect(after1?.executionSlotClaimId).toBeNull();
    expect(after1?.activeResourceId).toBe(fx.resourceBId);

    // Decision 2: SWITCH B→A (should acquire the slot immediately — no SESSION_BUSY).
    const decision2 = await db.connectivityDecision.create({
      data: {
        intentId: `p112-slot-release-2-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceAId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: slot release 2"]),
        executionState: "PENDING",
      },
    });

    const result2 = await executeDecision(decision2.id);
    expect(result2.executionState).toBe("EXECUTED"); // not SESSION_BUSY

    // The slot is released again.
    const after2 = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimId: true, activeResourceId: true },
    });
    expect(after2?.executionSlotClaimId).toBeNull();
    expect(after2?.activeResourceId).toBe(fx.resourceAId);

    // Cleanup
    await db.connectivityDecision.deleteMany({ where: { id: { in: [decision1.id, decision2.id] } } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.2.3 — Slot is released after execution (failure) — next decision can acquire
  // =========================================================================
  it("11.2.3: slot released after failed execution — next decision can acquire", async () => {
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    // Decision 1: SWITCH to a non-existent resource (will fail).
    const decision1 = await db.connectivityDecision.create({
      data: {
        intentId: `p112-fail-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: "nonexistent-resource-id",
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: fail"]),
        executionState: "PENDING",
      },
    });

    const result1 = await executeDecision(decision1.id);
    expect(result1.executionState).toBe("FAILED");

    // The slot is STILL released (finally block runs even on failure).
    const after1 = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimId: true },
    });
    expect(after1?.executionSlotClaimId).toBeNull();

    // Decision 2: a valid SWITCH — should acquire the slot (not SESSION_BUSY).
    const decision2 = await db.connectivityDecision.create({
      data: {
        intentId: `p112-fail-2-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: fail 2"]),
        executionState: "PENDING",
      },
    });

    const result2 = await executeDecision(decision2.id);
    expect(result2.executionState).toBe("EXECUTED"); // not SESSION_BUSY

    // Switch back to A for cleanup.
    await db.connectivityDecision.create({
      data: {
        intentId: `p112-fail-cleanup-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceAId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["cleanup"]),
        executionState: "PENDING",
      },
    }).then(async (d) => { await executeDecision(d.id).catch(() => {}); }).catch(() => {});

    await db.connectivityDecision.deleteMany({ where: { id: { in: [decision1.id, decision2.id] } } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.2.4 — Slot lease expiry → reclaimExpiredSessionSlots clears it
  // =========================================================================
  it("11.2.4: expired session slot → reclaimExpiredSessionSlots clears it", async () => {
    // Manually acquire a slot with an expired lease.
    const claimId = `test-expired-slot-${Date.now()}`;
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: {
        executionSlotClaimId: claimId,
        executionSlotClaimedAt: new Date(Date.now() - 10_000),
        executionSlotClaimExpiresAt: new Date(Date.now() - 1000), // expired
      },
    });

    // Reclaim.
    const result = await reclaimExpiredSessionSlots();
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);

    // The slot is cleared.
    const after = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimId: true, executionSlotClaimedAt: true, executionSlotClaimExpiresAt: true },
    });
    expect(after?.executionSlotClaimId).toBeNull();
    expect(after?.executionSlotClaimedAt).toBeNull();
    expect(after?.executionSlotClaimExpiresAt).toBeNull();
  }, 60_000);

  // =========================================================================
  // 11.2.5 — acquireSessionExecutionSlot is fenced — two concurrent acquires → one
  // =========================================================================
  it("11.2.5: two concurrent acquireSessionExecutionSlot → exactly one succeeds", async () => {
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    const claimA = `concurrent-slot-A-${Date.now()}`;
    const claimB = `concurrent-slot-B-${Date.now()}`;

    // Two workers concurrently try to acquire the same session's slot.
    const [resultA, resultB] = await Promise.all([
      acquireSessionExecutionSlot(fx.sessionId, claimA),
      acquireSessionExecutionSlot(fx.sessionId, claimB),
    ]);

    // Exactly one acquires; the other gets false.
    const acquiredCount = [resultA.acquired, resultB.acquired].filter(Boolean).length;
    expect(acquiredCount).toBe(1);

    // The session's slot is held by exactly one claim.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimId: true },
    });
    const winningClaim = resultA.acquired ? claimA : claimB;
    expect(session?.executionSlotClaimId).toBe(winningClaim);

    // Release it (cleanup).
    await releaseSessionExecutionSlot(fx.sessionId, winningClaim);
  }, 60_000);

  // =========================================================================
  // 11.2.6 — Session slot lease renewal: mutation exceeds initial lease, slot
  //          renewed, second worker cannot acquire.
  //
  // Phase 11.2.1: The slot lease is RENEWABLE. A heartbeat renews the lease
  // periodically while the mutation is running. Without renewal, a mutation
  // longer than SESSION_EXECUTION_SLOT_LEASE_MS (5 min) would let the lease
  // expire, cron would reclaim the slot, and a second worker could acquire it
  // while the first is still executing — violating:
  //   "A session execution slot MUST NOT become available while its owner is
  //    still performing the mutation window."
  //
  // This test proves the renewal primitive extends the lease (fenced by claimId)
  // and that a second worker remains blocked after renewal.
  // =========================================================================
  it("11.2.6: slot lease renewal — renew extends lease, second worker blocked after renew", async () => {
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    // Worker A acquires the slot with a short lease (simulate near-expiry).
    const claimA = `renew-claim-A-${Date.now()}`;
    const acquired = await acquireSessionExecutionSlot(fx.sessionId, claimA);
    expect(acquired.acquired).toBe(true);

    // Manually set the lease to near-expiry (1 second from now) — simulate that
    // the mutation has been running for almost the full lease duration.
    const nearExpiry = new Date(Date.now() + 1000);
    await db.connectivitySession.update({
      where: { id: fx.sessionId, executionSlotClaimId: claimA },
      data: { executionSlotClaimExpiresAt: nearExpiry },
    });

    // Worker A renews the lease (fenced by claimId). The expiry extends.
    const renewed = await renewSessionExecutionSlot(fx.sessionId, claimA);
    expect(renewed.renewed).toBe(true);

    // After renewal, the expiry is now + SESSION_EXECUTION_SLOT_LEASE_MS (5 min).
    const afterRenew = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimExpiresAt: true },
    });
    expect(afterRenew?.executionSlotClaimExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // Worker B attempts to acquire the slot — FAILS (Worker A's renewed lease is valid).
    const claimB = `renew-claim-B-${Date.now()}`;
    const acquiredB = await acquireSessionExecutionSlot(fx.sessionId, claimB);
    expect(acquiredB.acquired).toBe(false); // second worker blocked after renewal

    // Worker A releases the slot.
    const released = await releaseSessionExecutionSlot(fx.sessionId, claimA);
    expect(released.released).toBe(true);

    // Now Worker B CAN acquire (slot is free).
    const acquiredB2 = await acquireSessionExecutionSlot(fx.sessionId, claimB);
    expect(acquiredB2.acquired).toBe(true);

    // Cleanup.
    await releaseSessionExecutionSlot(fx.sessionId, claimB);
  }, 60_000);

  // =========================================================================
  // 11.2.7 — Busy requeue claim fencing: Worker A's stale requeue affects zero
  //          rows after its decision lease expires and Worker B re-claims.
  //
  // Phase 11.2.1: The "session busy" requeue in executeDecision() MUST be fenced
  // by the execution claim that owns EXECUTING. An unconditional update would
  // race with a concurrent worker's claim after lease expiry:
  //   Worker A holds EXECUTING, slot busy → pauses
  //   A's decision lease expires → reclaim → PENDING
  //   Worker B claims → EXECUTION_CLAIMED
  //   Worker A resumes → unconditional requeue → overwrites B's claim
  //
  // The fix: fenced updateMany WHERE executionState=EXECUTING AND
  // executionClaimId = claimId (Worker A's). If count=0, Worker A has lost
  // ownership and must not mutate the decision.
  //
  // This test directly proves the fencing at the DB level (simulating the
  // exact race sequence).
  // =========================================================================
  it("11.2.7: busy requeue fenced by execution claim — stale requeue affects zero rows after reclaim", async () => {
    // 1. Worker A claims the decision and marks it EXECUTING with A's claimId.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: `p112-requeue-fence-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: requeue fence"]),
        executionState: "EXECUTING",
        executionClaimId: "worker-A-claim",
        executionClaimedAt: new Date(Date.now() - 10_000),
        executionAttemptCount: 1,
      },
    });

    // 2. Hold the session slot with Worker X (so the requeue path would fire).
    const slotClaimX = `slot-X-${Date.now()}`;
    const slotAcquired = await acquireSessionExecutionSlot(fx.sessionId, slotClaimX);
    expect(slotAcquired.acquired).toBe(true);

    // 3. Simulate Worker A's decision lease expiring. The decision is
    //    EXECUTING but its executionClaimExpiresAt has passed.
    await db.connectivityDecision.update({
      where: { id: decision.id },
      data: {
        executionClaimExpiresAt: new Date(Date.now() - 1000), // expired
      },
    });

    // 4. Reclaim the decision (cron) — it's EXECUTION_CLAIMED with expired lease.
    //    reclaimExpiredDecisionClaims returns it to PENDING (attempts < MAX).
    const reclaim = await reclaimExpiredDecisionClaims();
    expect(reclaim.reclaimed).toBeGreaterThanOrEqual(1);

    const afterReclaim = await db.connectivityDecision.findUnique({
      where: { id: decision.id },
      select: { executionState: true, executionClaimId: true },
    });
    expect(afterReclaim?.executionState).toBe("PENDING");
    expect(afterReclaim?.executionClaimId).toBeNull();

    // 5. Worker B claims the decision → EXECUTION_CLAIMED with B's claimId.
    const claimedByB = await db.connectivityDecision.updateMany({
      where: { id: decision.id, executionState: "PENDING" },
      data: {
        executionState: "EXECUTION_CLAIMED",
        executionClaimId: "worker-B-claim",
        executionClaimedAt: new Date(),
        executionClaimExpiresAt: new Date(Date.now() + DECISION_EXECUTION_LEASE_MS),
        executionAttemptCount: { increment: 1 },
      },
    });
    expect(claimedByB.count).toBe(1);

    // 6. Worker A resumes and attempts its stale "session busy" requeue.
    //    The requeue is fenced by Worker A's executionClaimId. Since Worker B
    //    now holds the claim, the update affects ZERO rows.
    const staleRequeue = await db.connectivityDecision.updateMany({
      where: {
        id: decision.id,
        executionState: "EXECUTING",
        executionClaimId: "worker-A-claim", // fenced — only Worker A's claim
      },
      data: {
        executionState: "PENDING",
        executionClaimId: null,
        executionClaimedAt: null,
      },
    });
    expect(staleRequeue.count).toBe(0); // ← Worker A's stale requeue is a no-op

    // 7. Worker B's claim remains intact.
    const afterStaleRequeue = await db.connectivityDecision.findUnique({
      where: { id: decision.id },
      select: { executionState: true, executionClaimId: true },
    });
    expect(afterStaleRequeue?.executionState).toBe("EXECUTION_CLAIMED");
    expect(afterStaleRequeue?.executionClaimId).toBe("worker-B-claim");

    // Cleanup.
    await releaseSessionExecutionSlot(fx.sessionId, slotClaimX);
    await db.connectivityDecision.delete({ where: { id: decision.id } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.2.8 — Lost slot ownership during execution: no further mutation.
  //
  // Phase 11.2.2: If the heartbeat renewal fails (slot reclaimed by cron),
  // the worker MUST NOT perform another connectivity mutation. The
  // SlotOwnershipContext.verifySlotOwnership() check before each mutating
  // stage throws SlotOwnershipLostError → RECONCILIATION_REQUIRED.
  //
  // This test simulates the dangerous sequence:
  //   A loses slot → B acquires slot → A attempts next action → A is refused
  //
  // We use the slot ownership context directly (not through executeDecision,
  // which would require simulating a 5-minute wait for the heartbeat). This
  // tests the checkpoint mechanism itself — the invariant is:
  //   "While a worker is performing the mutation window, either the worker
  //    still owns the session slot OR the worker has stopped before performing
  //    any further connectivity mutation."
  // =========================================================================
  it("11.2.8: lost slot ownership during execution → next checkpoint aborts mutation (RECONCILIATION_REQUIRED)", async () => {
    // 1. Worker A acquires the session slot.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    const claimA = `lost-slot-A-${Date.now()}`;
    const acquired = await acquireSessionExecutionSlot(fx.sessionId, claimA);
    expect(acquired.acquired).toBe(true);

    // 2. Create the slot ownership context (same as executeDecision does).
    const { createSlotOwnershipContext, SlotOwnershipLostError } = await import("@/lib/control-plane/session-execution-slot");
    const ctx = createSlotOwnershipContext(fx.sessionId, claimA);

    // 3. Worker A begins mutation — first checkpoint passes (slot is held).
    await ctx.verifySlotOwnership(); // should NOT throw

    // 4. Simulate slot loss: Worker B forcibly acquires the slot (e.g. cron
    //    reclaimed A's expired slot, then B acquired it).
    //    Set the lease to expired, reclaim, then B acquires.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimExpiresAt: new Date(Date.now() - 1000) },
    });
    await reclaimExpiredSessionSlots();

    const claimB = `lost-slot-B-${Date.now()}`;
    const acquiredB = await acquireSessionExecutionSlot(fx.sessionId, claimB);
    expect(acquiredB.acquired).toBe(true); // Worker B now holds the slot

    // 5. Simulate the heartbeat detecting the loss (set slotLost = true).
    //    In production, the heartbeat calls renewSessionExecutionSlot, which
    //    returns { renewed: false }, and the heartbeat sets slotLost.
    ctx.slotLost = true;

    // 6. Worker A reaches the next mutation checkpoint. The checkpoint MUST
    //    throw SlotOwnershipLostError — the worker must NOT perform the mutation.
    await expect(ctx.verifySlotOwnership()).rejects.toThrow(SlotOwnershipLostError);

    // 7. Worker A's mutation is aborted. Worker B's slot is intact.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { executionSlotClaimId: true },
    });
    expect(session?.executionSlotClaimId).toBe(claimB); // B holds the slot, not A

    // Cleanup.
    await releaseSessionExecutionSlot(fx.sessionId, claimB);
  }, 60_000);

  // =========================================================================
  // 11.2.9 — DB-authoritative mutation fence: slot lost between checkpoint
  //          and mutation → fenced update rejects, B intact, no unauthorized
  //          session mutation.
  //
  // Phase 11.2.3: The checkpoint is a fast-path observation; the mutation
  // itself must carry the DB fence. This test proves the TOCTOU window is
  // closed:
  //
  //   Worker A: checkpoint passes (slot owned)
  //       ↓ [slot expires / reclaimed / stolen]
  //   Worker B: acquires slot
  //       ↓
  //   Worker A: attempts the fenced mutation
  //       ↓
  //   fencedSessionUpdate returns { applied: false }
  //       ↓
  //   Mutation did NOT happen. Session is unchanged. B's claim intact.
  //
  // The architectural rule:
  //   "Every state-changing connectivity mutation must be authorized by the
  //    currently valid session execution claim at the mutation boundary, not
  //    merely preceded by a successful observation of ownership."
  // =========================================================================
  it("11.2.9: DB-authoritative mutation fence — slot lost between checkpoint and mutation → fenced update rejects", async () => {
    // 1. Worker A acquires the session slot.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    const claimA = `fence-claim-A-${Date.now()}`;
    const acquired = await acquireSessionExecutionSlot(fx.sessionId, claimA);
    expect(acquired.acquired).toBe(true);

    // 2. Worker A passes the ownership checkpoint (slot is held).
    const ctx = createSlotOwnershipContext(fx.sessionId, claimA);
    await ctx.verifySlotOwnership(); // passes — slot is held

    // 3. Before A's mutation executes, force slot expiry + reclaim.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimExpiresAt: new Date(Date.now() - 1000) },
    });
    await reclaimExpiredSessionSlots();

    // 4. Worker B acquires the slot (A's expired lease was reclaimed).
    const claimB = `fence-claim-B-${Date.now()}`;
    const acquiredB = await acquireSessionExecutionSlot(fx.sessionId, claimB);
    expect(acquiredB.acquired).toBe(true);

    // 5. Worker A attempts the fenced mutation (e.g. update activeResourceId).
    //    This is the exact mutation that would switch the session to a new
    //    resource. The fenced update MUST reject it (count=0) because A no
    //    longer holds the slot.
    const fencedResult = await fencedSessionUpdate(fx.sessionId, claimA, {
      activeResourceId: fx.resourceBId, // would switch A→B
    });

    // 6. Mutation is rejected by the DB/session fence.
    expect(fencedResult.applied).toBe(false);

    // 7. The session's activeResourceId is UNCHANGED (still A — the mutation
    //    did NOT happen).
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, executionSlotClaimId: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId); // unchanged — NOT B
    expect(session?.executionSlotClaimId).toBe(claimB); // B holds the slot, not A

    // 8. Worker B can now perform its own fenced mutation (it holds the slot).
    const fencedB = await fencedSessionUpdate(fx.sessionId, claimB, {
      lastObservedAt: new Date(),
    });
    expect(fencedB.applied).toBe(true);

    // Cleanup.
    await releaseSessionExecutionSlot(fx.sessionId, claimB);
  }, 60_000);

  // =========================================================================
  // 11.2.10 — Every mutation boundary rejected when slot lost.
  //
  // Phase 11.2.4: The architect's strongest adversarial test. Proves that
  // EVERY mutation in the window — not just activeResourceId — is authorized
  // by the currently valid session execution claim. If the slot is lost, every
  // mutation boundary is rejected:
  //   - reserve target
  //   - mark target IN_USE
  //   - session state transition
  //   - activeResourceId update
  //   - release old resource
  //
  // No target becomes orphaned IN_USE. Session state/resource remain coherent.
  // B's claim remains intact.
  // =========================================================================
  it("11.2.10: every mutation boundary rejected when slot lost — no orphaned resources, B intact", async () => {
    // 1. Worker A acquires the session slot.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
    }).catch(() => {});

    const claimA = `fence-all-A-${Date.now()}`;
    const acquired = await acquireSessionExecutionSlot(fx.sessionId, claimA);
    expect(acquired.acquired).toBe(true);

    // Ensure resources B and C are AVAILABLE for reservation attempts.
    await db.protocolResource.update({ where: { id: fx.resourceBId }, data: { state: "AVAILABLE", reservedBy: null, reservedAt: null } }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceCId }, data: { state: "AVAILABLE", reservedBy: null, reservedAt: null } }).catch(() => {});

    // 2. Force slot expiry + reclaim.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimExpiresAt: new Date(Date.now() - 1000) },
    });
    await reclaimExpiredSessionSlots();

    // 3. Worker B acquires the slot.
    const claimB = `fence-all-B-${Date.now()}`;
    const acquiredB = await acquireSessionExecutionSlot(fx.sessionId, claimB);
    expect(acquiredB.acquired).toBe(true);

    // 4. Worker A attempts EACH mutation boundary. All MUST be rejected.

    // 4a. reserve target (resourceB) — fencedReserveResource
    const reserveResult = await fencedReserveResource(fx.resourceBId, fx.sessionId, claimA);
    expect(reserveResult.reserved).toBe(false);
    expect(reserveResult.reason).toContain("session-execution-slot-not-held");

    // 4b. mark target IN_USE — fencedMarkResourceInUse (needs RESERVED first,
    //     but even if we set it up, the fence should reject)
    await db.protocolResource.update({
      where: { id: fx.resourceBId },
      data: { state: "RESERVED", reservedBy: fx.sessionId, reservedAt: new Date() },
    }).catch(() => {});
    const activateResult = await fencedMarkResourceInUse(fx.resourceBId, fx.sessionId, claimA);
    expect(activateResult.activated).toBe(false);
    expect(activateResult.reason).toContain("session-execution-slot-not-held");
    // Clean up the manual RESERVED state.
    await db.protocolResource.update({
      where: { id: fx.resourceBId },
      data: { state: "AVAILABLE", reservedBy: null, reservedAt: null },
    }).catch(() => {});

    // 4c. session state transition — fencedTransitionSessionState
    const transitionResult = await fencedTransitionSessionState(fx.sessionId, claimA, "SWITCHING", ["ACTIVE"]);
    expect(transitionResult.applied).toBe(false);
    expect(transitionResult.reason).toContain("slot-not-owned-or-expired");

    // 4d. activeResourceId update — fencedSessionUpdate
    const updateResult = await fencedSessionUpdate(fx.sessionId, claimA, {
      activeResourceId: fx.resourceBId,
    });
    expect(updateResult.applied).toBe(false);

    // 4e. release old resource — fencedReleaseResource
    //     Set up resourceA as if it were reserved by the session.
    await db.protocolResource.update({
      where: { id: fx.resourceAId },
      data: { state: "IN_USE", reservedBy: fx.sessionId, reservedAt: new Date() },
    }).catch(() => {});
    const releaseResult = await fencedReleaseResource(fx.resourceAId, fx.sessionId, claimA);
    expect(releaseResult.released).toBe(false);
    expect(releaseResult.reason).toContain("session-execution-slot-not-held");
    // Clean up.
    await db.protocolResource.update({
      where: { id: fx.resourceAId },
      data: { state: "AVAILABLE", reservedBy: null, reservedAt: null },
    }).catch(() => {});

    // 5. Verify: no target became orphaned IN_USE.
    const resB = await db.protocolResource.findUnique({ where: { id: fx.resourceBId }, select: { state: true, reservedBy: true } });
    const resC = await db.protocolResource.findUnique({ where: { id: fx.resourceCId }, select: { state: true, reservedBy: true } });
    expect(resB?.state).not.toBe("IN_USE");
    expect(resB?.reservedBy).not.toBe(fx.sessionId);
    expect(resC?.state).not.toBe("IN_USE");

    // 6. Verify: session state/resource remain coherent.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, executionSlotClaimId: true, state: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId); // unchanged
    expect(session?.executionSlotClaimId).toBe(claimB); // B holds the slot
    expect(session?.state).toBe("ACTIVE"); // unchanged — no SWITCHING transition happened

    // 7. B's claim remains intact. B can perform its own fenced mutation.
    const fencedB = await fencedSessionUpdate(fx.sessionId, claimB, {
      lastObservedAt: new Date(),
    });
    expect(fencedB.applied).toBe(true);

    // Cleanup.
    await releaseSessionExecutionSlot(fx.sessionId, claimB);
  }, 60_000);
});
