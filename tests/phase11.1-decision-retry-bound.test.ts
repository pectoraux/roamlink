/**
 * Phase 11.1 — Decision Retry Bound (DB-backed runtime)
 *
 * Proves acceptance invariant #1:
 *   "A decision cannot execute more than DECISION_MAX_ATTEMPTS times."
 *
 * The defect (found in fc6b63f audit):
 *   DECISION_MAX_ATTEMPTS=3 was declared but never referenced. attemptCount
 *   was hardcoded to 0 with the comment "not tracked on the row yet." There
 *   was no executionAttemptCount column. reclaimExpiredDecisionClaims returned
 *   EXECUTION_CLAIMED → PENDING unconditionally — a decision that keeps crashing
 *   the worker mid-execution retried indefinitely with no dead-letter.
 *
 * The fix:
 *   - executionAttemptCount column added to ConnectivityDecision.
 *   - Incremented at claim time (both claimDecisionForExecution and executeDecision).
 *   - reclaimExpiredDecisionClaims dead-letters at >= DECISION_MAX_ATTEMPTS
 *     (parallel to ReevaluationEvent dead-lettering).
 *   - claimDecisionForExecution dead-letters defensively if a decision reaches
 *     PENDING with attemptCount >= MAX.
 *   - DECISION_DEAD_LETTER state added to the protocol.
 *
 * Tests:
 *   11.1.1: claimDecisionForExecution increments executionAttemptCount on each claim.
 *   11.1.2: crash-retry loop is bounded — after MAX_ATTEMPTS claims, the decision
 *           is DEAD_LETTER (not returned to PENDING for infinite retry).
 *   11.1.3: a successfully executed decision has attemptCount=1 (not inflated).
 *   11.1.4: reclaimExpiredDecisionClaims returns { reclaimed, deadLettered }.
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase11.1-decision-retry-bound.test.ts
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
import {
  claimDecisionForExecution,
  executeDecision,
  reclaimExpiredDecisionClaims,
  DECISION_MAX_ATTEMPTS,
  DECISION_EXECUTION_LEASE_MS,
  DECISION_DEAD_LETTER,
} from "@/lib/control-plane/decision-executor";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  subjectId: string;
  resourceAId: string;
  resourceBId: string;
  entitlementId: string;
  providerInstanceId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase111-${Date.now()}@test.roamlink`;
  const slug = `p111-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P11.1 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P111 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P111 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });
  const capB = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
  const resB = await db.protocolResource.create({ data: { capabilityId: capB.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "B" }), capacity: JSON.stringify({ totalBandwidthMbps: 300 }), state: "AVAILABLE" } });

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

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: ent.id });

  // ACTIVATE resource A so the session has an active resource.
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p111-${session.id}` });
  await executeAction(action.id);

  // Mark the ACTIVATE decision as EXECUTED (the action was executed directly,
  // not via executeDecision, so the decision's executionState is still PENDING).
  // This prevents it from being picked up by claimDecisionForExecution in tests.
  await db.connectivityDecision.update({
    where: { id: decision.decisionId },
    data: { executionState: "EXECUTED", executedAt: new Date(), executedActionId: action.id },
  }).catch(() => {});

  const cleanup = async () => {
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resA.id, resB.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resA.id, resB.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capA.id, capB.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bA.id, bB.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { tenantId: tenant.id, subjectId, resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 11.1 — Decision Retry Bound (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // =========================================================================
  // 11.1.1 — claimDecisionForExecution increments executionAttemptCount
  // =========================================================================
  it("11.1.1: claimDecisionForExecution increments executionAttemptCount on each claim", async () => {
    // Create a PENDING SWITCH decision (don't execute it — just claim it).
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-claim-test-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: attempt-count"]),
        executionState: "PENDING",
      },
    });

    // Before claim: attemptCount = 0
    expect(decision.executionAttemptCount).toBe(0);

    // Claim #1 — scoped to this decision to avoid interference from other tests' PENDING decisions
    const claimed1 = await claimDecisionForExecution("test-worker-1", { decisionId: decision.id });
    expect(claimed1).not.toBeNull();
    expect(claimed1!.id).toBe(decision.id);
    expect(claimed1!.attemptCount).toBe(1); // incremented from 0 to 1

    // Verify in DB
    const after1 = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionAttemptCount: true, executionState: true } });
    expect(after1?.executionAttemptCount).toBe(1);
    expect(after1?.executionState).toBe("EXECUTION_CLAIMED");

    // Manually expire the claim and reclaim to PENDING for the next claim.
    await db.connectivityDecision.update({
      where: { id: decision.id },
      data: { executionClaimExpiresAt: new Date(Date.now() - 1000) },
    });
    await reclaimExpiredDecisionClaims();

    const afterReclaim1 = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionAttemptCount: true, executionState: true } });
    expect(afterReclaim1?.executionState).toBe("PENDING");
    expect(afterReclaim1?.executionAttemptCount).toBe(1); // preserved across reclaim

    // Claim #2
    const claimed2 = await claimDecisionForExecution("test-worker-2", { decisionId: decision.id });
    expect(claimed2).not.toBeNull();
    expect(claimed2!.attemptCount).toBe(2); // incremented from 1 to 2

    const after2 = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionAttemptCount: true } });
    expect(after2?.executionAttemptCount).toBe(2);

    // Cleanup: mark the decision terminal so it doesn't interfere with other tests.
    await db.connectivityDecision.update({
      where: { id: decision.id },
      data: { executionState: "SKIPPED", executedAt: new Date() },
    }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.1.2 — crash-retry loop is bounded: after MAX_ATTEMPTS, DEAD_LETTER
  // =========================================================================
  it("11.1.2: crash-retry loop bounded — after MAX_ATTEMPTS claims, decision is DEAD_LETTER (not infinite retry)", async () => {
    // Create a PENDING SWITCH decision.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-deadletter-test-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: dead-letter"]),
        executionState: "PENDING",
      },
    });

    // Simulate the crash-retry loop: claim → crash (expire lease) → reclaim → repeat.
    // Each cycle increments executionAttemptCount by 1.
    // After DECISION_MAX_ATTEMPTS (3) claims, the next reclaim should DEAD_LETTER.
    for (let i = 1; i <= DECISION_MAX_ATTEMPTS; i++) {
      // Claim — scoped to this decision to avoid interference from other tests
      const claimed = await claimDecisionForExecution(`crash-worker-${i}`, { decisionId: decision.id });
      expect(claimed).not.toBeNull();
      expect(claimed!.attemptCount).toBe(i);

      // Simulate crash: expire the lease
      await db.connectivityDecision.update({
        where: { id: decision.id },
        data: { executionClaimExpiresAt: new Date(Date.now() - 1000) },
      });

      // Reclaim
      const reclaimResult = await reclaimExpiredDecisionClaims();

      if (i < DECISION_MAX_ATTEMPTS) {
        // Before MAX: returned to PENDING for retry
        const after = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionState: true, executionAttemptCount: true } });
        expect(after?.executionState).toBe("PENDING");
        expect(after?.executionAttemptCount).toBe(i);
      } else {
        // At MAX (i === DECISION_MAX_ATTEMPTS): the reclaim should dead-letter
        // because attemptCount (3) >= DECISION_MAX_ATTEMPTS (3).
        expect(reclaimResult.deadLettered).toBeGreaterThanOrEqual(1);

        const after = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionState: true, executionAttemptCount: true } });
        expect(after?.executionState).toBe("DEAD_LETTER");
        expect(after?.executionAttemptCount).toBe(DECISION_MAX_ATTEMPTS);
      }
    }

    // Verify: the decision is DEAD_LETTER, NOT PENDING (no infinite retry).
    const final = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionState: true, executionAttemptCount: true } });
    expect(final?.executionState).toBe("DEAD_LETTER");
    expect(final?.executionAttemptCount).toBe(DECISION_MAX_ATTEMPTS);

    // Verify: a subsequent claimDecisionForExecution does NOT pick up a DEAD_LETTER decision.
    const claimAttempt = await claimDecisionForExecution("post-deadletter-worker", { decisionId: decision.id });
    expect(claimAttempt).toBeNull(); // DEAD_LETTER is not claimable

    // Cleanup
    await db.connectivityDecision.delete({ where: { id: decision.id } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.1.3 — successful execution has attemptCount=1 (not inflated)
  // =========================================================================
  it("11.1.3: successfully executed decision has executionAttemptCount=1 (not inflated)", async () => {
    // Create a PENDING SWITCH decision targeting B (which is AVAILABLE + bound).
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-success-test-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: success"]),
        executionState: "PENDING",
      },
    });

    // Execute it (should succeed — B is AVAILABLE and bound).
    const result = await executeDecision(decision.id);
    expect(result.executionState).toBe("EXECUTED");

    // Verify: attemptCount = 1 (one claim, one successful execution).
    const after = await db.connectivityDecision.findUnique({ where: { id: decision.id }, select: { executionAttemptCount: true, executionState: true } });
    expect(after?.executionAttemptCount).toBe(1);
    expect(after?.executionState).toBe("EXECUTED");

    // Switch back to A for subsequent tests (cleanup the session state).
    await db.connectivityDecision.create({
      data: {
        intentId: `p111-switch-back-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceAId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: switch back"]),
        executionState: "PENDING",
      },
    }).then(async (d) => {
      await executeDecision(d.id).catch(() => {});
    }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.1.4 — reclaimExpiredDecisionClaims returns { reclaimed, deadLettered }
  // =========================================================================
  it("11.1.4: reclaimExpiredDecisionClaims returns { reclaimed, deadLettered } (deadLettered is additive)", async () => {
    // Create two decisions: one that will be reclaimed (attemptCount < MAX),
    // and one that will be dead-lettered (attemptCount >= MAX).
    const reclaimDecision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-reclaim-test-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: reclaim"]),
        executionState: "EXECUTION_CLAIMED",
        executionClaimExpiresAt: new Date(Date.now() - 1000), // expired
        executionAttemptCount: 1, // below MAX
      },
    });

    const deadLetterDecision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-deadletter2-test-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: deadletter2"]),
        executionState: "EXECUTION_CLAIMED",
        executionClaimExpiresAt: new Date(Date.now() - 1000), // expired
        executionAttemptCount: DECISION_MAX_ATTEMPTS, // at MAX
      },
    });

    // Reclaim both.
    const result = await reclaimExpiredDecisionClaims();

    // The reclaimDecision should be returned to PENDING.
    const reclaimAfter = await db.connectivityDecision.findUnique({ where: { id: reclaimDecision.id }, select: { executionState: true } });
    expect(reclaimAfter?.executionState).toBe("PENDING");

    // The deadLetterDecision should be DEAD_LETTER.
    const deadLetterAfter = await db.connectivityDecision.findUnique({ where: { id: deadLetterDecision.id }, select: { executionState: true } });
    expect(deadLetterAfter?.executionState).toBe("DEAD_LETTER");

    // The result includes both counts.
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    expect(result.deadLettered).toBeGreaterThanOrEqual(1);

    // Cleanup
    await db.connectivityDecision.deleteMany({ where: { id: { in: [reclaimDecision.id, deadLetterDecision.id] } } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.1.5 — Adversarial concurrency: decision at MAX + two concurrent claims
  //           → exactly one terminal transition, DEAD_LETTER remains terminal.
  //
  // Phase 11.1.1 (fenced): The dead-letter transition MUST be DB-authoritative.
  // Before the fix, the dead-letter was an unfenced `update` after a read —
  // a TOCTOU race:
  //   Worker A reads: PENDING, attempts=3
  //   Worker B claims: PENDING → EXECUTION_CLAIMED (fenced, increments to 4)
  //   Worker A dead-letters: overwrites EXECUTION_CLAIMED → DEAD_LETTER
  // This destroys Worker B's claim mid-execution. The fix: fenced updateMany
  // with WHERE guards on state + attemptCount. This test proves the race is closed.
  // =========================================================================
  it("11.1.5: concurrent claims on decision at MAX → exactly one terminal transition, no claim survives", async () => {
    // Create a PENDING decision at MAX attempts (the poison threshold).
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-concurrency-test-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: concurrency"]),
        executionState: "PENDING",
        executionAttemptCount: DECISION_MAX_ATTEMPTS, // already at MAX
      },
    });

    // Two workers concurrently call claimDecisionForExecution on the same decision.
    // Both read it as PENDING with attempts=MAX. Both try to dead-letter it.
    // The fix: the dead-letter is a fenced updateMany. Exactly one succeeds
    // (count=1); the other gets count=0 and recurses (returns null or a
    // different decision).
    const [claimA, claimB] = await Promise.all([
      claimDecisionForExecution("concurrent-worker-A", { decisionId: decision.id }),
      claimDecisionForExecution("concurrent-worker-B", { decisionId: decision.id }),
    ]);

    // Neither worker should have claimed the decision for EXECUTION.
    // (Both would have tried to dead-letter it; neither proceeds to EXECUTION_CLAIMED.)
    // A worker only returns a non-null result if it successfully claimed for execution.
    // Since the decision is at MAX, neither can claim it — both should return null
    // (or a different decision, but we scoped to this decisionId).
    expect(claimA).toBeNull();
    expect(claimB).toBeNull();

    // The decision is now DEAD_LETTER (terminal). Exactly one dead-letter
    // transition succeeded — but both workers observed it as terminal.
    const final = await db.connectivityDecision.findUnique({
      where: { id: decision.id },
      select: { executionState: true, executionAttemptCount: true, executionClaimId: true },
    });

    // DEAD_LETTER is terminal — not PENDING, not EXECUTION_CLAIMED, not EXECUTING.
    expect(final?.executionState).toBe("DEAD_LETTER");
    expect(final?.executionAttemptCount).toBe(DECISION_MAX_ATTEMPTS); // not incremented by dead-letter
    expect(final?.executionClaimId).toBeNull(); // no claim survived

    // Verify: no action was created for this decision (neither worker executed).
    const actions = await db.connectivityAction.findMany({ where: { decisionId: decision.id } });
    expect(actions.length).toBe(0);

    // Cleanup
    await db.connectivityDecision.delete({ where: { id: decision.id } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.1.6 — Adversarial concurrency: concurrent executeDecision at MAX
  //           → no execution proceeds, DEAD_LETTER terminal.
  //
  // Same race, but through the executeDecision() direct-call path (the
  // reevaluation worker calls executeDecision after producing a decision).
  // =========================================================================
  it("11.1.6: concurrent executeDecision on decision at MAX → no execution, DEAD_LETTER terminal", async () => {
    // Create a PENDING decision at MAX attempts.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: `p111-exec-concurrency-${Date.now()}`,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: exec concurrency"]),
        executionState: "PENDING",
        executionAttemptCount: DECISION_MAX_ATTEMPTS, // at MAX
      },
    });

    // Two workers concurrently call executeDecision on the same decision.
    // Both read it as PENDING with attempts=MAX. Both try to dead-letter it.
    // The fix: fenced updateMany. Exactly one dead-letters; the other gets
    // count=0 and returns "decision-state-changed-concurrently".
    const [resultA, resultB] = await Promise.all([
      executeDecision(decision.id),
      executeDecision(decision.id),
    ]);

    // At least one reports the dead-letter (FAILED + "dead-lettered:max-attempts").
    // The other either also reports the dead-letter (if it read before the write)
    // or reports "decision-state-changed-concurrently" (if it read after).
    // Neither reports EXECUTED — no execution proceeds.
    const deadLetterCount = [resultA, resultB].filter(
      (r) => r.executionState === "FAILED" && r.error?.includes("dead-lettered"),
    ).length;
    const concurrentCount = [resultA, resultB].filter(
      (r) => r.error === "decision-state-changed-concurrently",
    ).length;

    // At least one dead-lettered; the rest either also dead-lettered or saw concurrent change.
    expect(deadLetterCount).toBeGreaterThanOrEqual(1);
    expect(deadLetterCount + concurrentCount).toBe(2);

    // Neither worker executed the decision.
    expect(resultA.executionState).not.toBe("EXECUTED");
    expect(resultB.executionState).not.toBe("EXECUTED");

    // The decision is DEAD_LETTER (terminal).
    const final = await db.connectivityDecision.findUnique({
      where: { id: decision.id },
      select: { executionState: true, executionAttemptCount: true, executionClaimId: true },
    });
    expect(final?.executionState).toBe("DEAD_LETTER");
    expect(final?.executionAttemptCount).toBe(DECISION_MAX_ATTEMPTS); // not incremented
    expect(final?.executionClaimId).toBeNull(); // no claim survived

    // No action was created (neither worker executed).
    const actions = await db.connectivityAction.findMany({ where: { decisionId: decision.id } });
    expect(actions.length).toBe(0);

    // Cleanup
    await db.connectivityDecision.delete({ where: { id: decision.id } }).catch(() => {});
  }, 60_000);
});
