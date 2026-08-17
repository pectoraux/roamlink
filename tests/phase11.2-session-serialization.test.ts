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
  reclaimExpiredSessionSlots,
  SESSION_EXECUTION_SLOT_LEASE_MS,
} from "@/lib/control-plane/session-execution-slot";

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
});
