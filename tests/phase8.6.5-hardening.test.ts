/**
 * Phase 8.6.5 — Observation Control Plane Hardening (DB-backed runtime)
 *
 * Proves the five hardening requirements against the real PostgreSQL database:
 *
 *   1. Measurement ingestion idempotency (duplicate observation → one measurement)
 *   2. ResourceHealth as a rebuildable projection
 *   3. Freshness clock policy (expired current measurement → probe scheduled)
 *   4. ReevaluationEvent lifecycle (claim fencing, lease expiry, dead-letter)
 *   5. Decision triggering separated from execution
 *
 * Plus: observation failure does not corrupt session/action state.
 *
 * Requires DATABASE_URL (PostgreSQL). Run via: bun test tests/phase8.6.5-hardening.test.ts
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
import { ingestMeasurement, computeDeduplicationKey } from "@/lib/control-plane/measurement-store";
import { deriveResourceHealth, getResourceHealth, rebuildResourceHealth, verifyProjectionInvariant } from "@/lib/control-plane/health-derivation";
import { probeStaleActiveResources, probeAndIngest } from "@/lib/control-plane/observation";
import {
  claimReevaluationEvent,
  processPendingEvents,
  processPendingEventsForResource,
  processOneEvent,
  reclaimExpiredClaims,
  emitReevaluationEvent,
  EVENT_LEASE_MS,
  EVENT_MAX_ATTEMPTS,
} from "@/lib/control-plane/reevaluation";
import { executePendingDecisions, executeDecision } from "@/lib/control-plane/decision-executor";
import { assertActiveConnectivityInvariant } from "@/lib/control-plane/invariant-checker";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";

// ---------------------------------------------------------------------------
// Fixture (reused structure from 8.6)
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  subjectId: string;
  capabilityAId: string;
  resourceAId: string;
  resourceBId: string;
  entitlementId: string;
  bindingAId: string;
  providerInstanceId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
};

async function provisionMockResource(entitlementId: string, providerInstanceId: string): Promise<string> {
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: entitlementId },
    include: { capability: { select: { type: true } } },
  });
  const entInput: ConnectivityEntitlementInput = {
    id: entitlement!.id,
    tenantId: entitlement!.tenantId,
    subscriptionId: entitlement!.subscriptionId,
    status: entitlement!.status,
    capabilityType: entitlement!.capability?.type ?? "INTERNET",
    capabilitySet: JSON.parse(entitlement!.capabilitySet),
    policy: entitlement!.policy ? JSON.parse(entitlement!.policy) : null,
    validFrom: entitlement!.validFrom,
    validUntil: entitlement!.validUntil ?? null,
  };
  const bindingInput: ProviderResourceBindingInput = {
    id: "fixture-binding",
    entitlementId,
    providerType: "mock",
    providerResourceId: null,
    providerMetadata: null,
    status: "UNBOUND",
    provisioningState: null,
    providerInstanceId,
    providerInstanceConfiguration: null,
  };
  const result = await mockConnectivityProvider.provision({ entitlement: entInput, binding: bindingInput });
  if (!result.providerResourceId) throw new Error("mock provision did not return a providerResourceId");
  return result.providerResourceId;
}

async function setupFixture(): Promise<Fixture> {
  const subjectId = `phase865-subject-${Date.now()}`;
  const slug = `phase865-${Date.now().toString(36)}`;

  const tenant = await db.tenant.create({ data: { name: `Phase 8.6.5 Tenant ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter SaaasPlan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });

  const capType = "INTERNET";
  let connectivityCapability = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!connectivityCapability) {
    connectivityCapability = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "Internet connectivity" } });
  }

  const providerInstance = await db.connectivityProviderInstance.create({
    data: { tenantId: tenant.id, providerType: "mock", name: `Phase 8.6.5 Mock ${slug}`, status: "active", configuration: JSON.stringify({}) },
  });

  const entitlement = await db.connectivityEntitlement.create({
    data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: connectivityCapability.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId },
  });

  const capabilityA = await db.protocolCapability.create({
    data: { tenantId: tenant.id, providerInstanceId: providerInstance.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" },
  });
  const resourceA = await db.protocolResource.create({
    data: { capabilityId: capabilityA.id, providerInstanceId: providerInstance.id, identifiers: JSON.stringify({ hotspotId: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" },
  });

  const capabilityB = await db.protocolCapability.create({
    data: { tenantId: tenant.id, providerInstanceId: providerInstance.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" },
  });
  const resourceB = await db.protocolResource.create({
    data: { capabilityId: capabilityB.id, providerInstanceId: providerInstance.id, identifiers: JSON.stringify({ hotspotId: "B" }), capacity: JSON.stringify({ totalBandwidthMbps: 300 }), state: "AVAILABLE" },
  });

  const providerResourceA = await provisionMockResource(entitlement.id, providerInstance.id);
  const bindingA = await db.providerResourceBinding.create({
    data: { entitlementId: entitlement.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: providerResourceA, providerMetadata: JSON.stringify({ mock: true }), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: providerInstance.id },
  });
  await db.protocolResource.update({ where: { id: resourceA.id }, data: { providerBindingId: bindingA.id } });

  const providerResourceB = await provisionMockResource(entitlement.id, providerInstance.id);
  const bindingB = await db.providerResourceBinding.create({
    data: { entitlementId: entitlement.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: providerResourceB, providerMetadata: JSON.stringify({ mock: true }), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: providerInstance.id },
  });
  await db.protocolResource.update({ where: { id: resourceB.id }, data: { providerBindingId: bindingB.id } });

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: entitlement.id });

  const cleanup = async () => {
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resourceA.id, resourceB.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resourceA.id, resourceB.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capabilityA.id, capabilityB.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bindingA.id, bindingB.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: entitlement.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: providerInstance.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
  };

  return {
    tenantId: tenant.id, subjectId,
    capabilityAId: capabilityA.id, resourceAId: resourceA.id, resourceBId: resourceB.id,
    entitlementId: entitlement.id, bindingAId: bindingA.id, providerInstanceId: providerInstance.id,
    sessionId: session.id, cleanup,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 8.6.5 — Observation Control Plane Hardening (DB-backed)", () => {
  // =========================================================================
  // 1. Measurement ingestion idempotency
  // =========================================================================
  describe("1. Measurement idempotency", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.1: duplicate observation → one persisted measurement", async () => {
      const capturedAt = new Date();
      const metrics = { throughputDownMbps: 50, latencyMs: 20 };
      const deduplicationKey = computeDeduplicationKey({ resourceId: fx.resourceAId, capturedAt, source: "ADAPTER", metrics });

      // First ingest
      const r1 = await ingestMeasurement({
        resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
        type: "QUALITY", metrics, source: "ADAPTER", confidence: 0.8, capturedAt,
        deduplicationKey, triggerReevaluation: false,
      });
      expect(r1.duplicate).toBe(false);

      // Second ingest with the SAME deduplicationKey → duplicate, same ID
      const r2 = await ingestMeasurement({
        resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
        type: "QUALITY", metrics, source: "ADAPTER", confidence: 0.8, capturedAt,
        deduplicationKey, triggerReevaluation: false,
      });
      expect(r2.duplicate).toBe(true);
      expect(r2.measurementId).toBe(r1.measurementId);

      // Only one measurement row exists
      const count = await db.connectivityMeasurement.count({ where: { resourceId: fx.resourceAId, capturedAt } });
      expect(count).toBe(1);
    }, 60_000);

    it("8.6.5.1b: same observation identity (computed key) → one measurement", async () => {
      const capturedAt = new Date();
      const metrics = { throughputDownMbps: 40, latencyMs: 30 };

      // Both ingests omit deduplicationKey → computed from identity. Same
      // (resourceId, capturedAt, source, metrics) → same key → one row.
      const r1 = await ingestMeasurement({
        resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
        type: "QUALITY", metrics, source: "ADAPTER", capturedAt, triggerReevaluation: false,
      });
      const r2 = await ingestMeasurement({
        resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
        type: "QUALITY", metrics, source: "ADAPTER", capturedAt, triggerReevaluation: false,
      });
      expect(r1.duplicate).toBe(false);
      expect(r2.duplicate).toBe(true);
      expect(r2.measurementId).toBe(r1.measurementId);
    }, 60_000);
  });

  // =========================================================================
  // 2. ResourceHealth as a rebuildable projection
  // =========================================================================
  describe("2. ResourceHealth projection rebuild", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.2: rebuild ResourceHealth from measurements → identical result", async () => {
      // Inject a few measurements to build up a health snapshot
      for (let i = 0; i < 4; i++) {
        await ingestMeasurement({
          resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
          type: "QUALITY",
          metrics: { throughputDownMbps: i < 2 ? 50 : 5, latencyMs: i < 2 ? 20 : 250 },
          source: "ADAPTER", capturedAt: new Date(Date.now() - (4 - i) * 10_000),
          triggerReevaluation: false,
        });
      }

      const before = await getResourceHealth(fx.resourceAId);
      expect(before).not.toBeNull();

      // Verify the projection invariant: delete + rebuild → same state
      const result = await verifyProjectionInvariant(fx.resourceAId);
      expect(result.matches).toBe(true);
      expect(result.before?.status).toBe(result.after?.status);
      expect(result.before?.quality).toBeCloseTo(result.after!.quality, 3);
      expect(result.before?.sampleCount).toBe(result.after?.sampleCount);
      expect(result.before?.degradedCount).toBe(result.after?.degradedCount);
    }, 60_000);
  });

  // =========================================================================
  // 3. Freshness clock policy — expired current measurement → probe scheduled
  // =========================================================================
  describe("3. Freshness clock policy", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.3: expired current-resource measurement → probeStaleActiveResources re-probes", async () => {
      // 1. ACTIVATE A
      const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
      const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `phase865-freshness-${fx.sessionId}` });
      await executeAction(action.id);

      // 2. Backdate all measurements on A to be EXPIRED (>120s old)
      await db.connectivityMeasurement.updateMany({
        where: { resourceId: fx.resourceAId },
        data: { capturedAt: new Date(Date.now() - 180_000) },
      });
      // Re-derive health so the snapshot reflects EXPIRED freshness
      await deriveResourceHealth(fx.resourceAId);
      const expiredHealth = await getResourceHealth(fx.resourceAId);
      expect(expiredHealth?.freshness).toBe("EXPIRED");

      // 3. probeStaleActiveResources should re-probe A (it's EXPIRED)
      const result = await probeStaleActiveResources();
      expect(result.probed).toBeGreaterThan(0);

      // 4. A new measurement was created by the re-observation (not EXPIRED)
      const freshMeasurement = await db.connectivityMeasurement.findFirst({
        where: { resourceId: fx.resourceAId, freshness: { not: "EXPIRED" } },
        orderBy: { capturedAt: "desc" },
      });
      expect(freshMeasurement).not.toBeNull();

      // 5. Health is recomputed — freshness is no longer EXPIRED
      const newHealth = await getResourceHealth(fx.resourceAId);
      expect(newHealth?.freshness).not.toBe("EXPIRED");
    }, 180_000);
  });

  // =========================================================================
  // 4. ReevaluationEvent lifecycle (claim fencing, lease expiry, dead-letter)
  // =========================================================================
  describe("4. ReevaluationEvent lifecycle", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.4: two workers → one event claim (fenced)", async () => {
      // Use a unique subjectId so the scoped claim only finds this event.
      const testSubject = `claim-test-${Date.now()}`;
      const { eventId } = await emitReevaluationEvent({
        type: "POLICY_CHANGED", subjectId: testSubject,
        payload: { reason: "test" }, idempotencyKey: `phase865-claim-${Date.now()}`,
      });

      // Worker A claims it (scoped to this subject)
      const claimedA = await claimReevaluationEvent("worker-A", { subjectId: testSubject });
      expect(claimedA).not.toBeNull();
      expect(claimedA!.id).toBe(eventId);
      expect(claimedA!.state).toBe("CLAIMED");
      expect(claimedA!.claimId).toContain("worker-A");

      // Worker B tries to claim the same subject — should get null (event is CLAIMED by A)
      const claimedB = await claimReevaluationEvent("worker-B", { subjectId: testSubject });
      expect(claimedB).toBeNull();

      // The event is still CLAIMED by worker A (not stolen)
      const event = await db.reevaluationEvent.findUnique({ where: { id: eventId }, select: { state: true, claimId: true } });
      expect(event?.state).toBe("CLAIMED");
      expect(event?.claimId).toContain("worker-A");
    }, 60_000);

    it("8.6.5.5: crashed worker → lease expires → event reclaimed", async () => {
      const testSubject = `crash-test-${Date.now()}`;
      const { eventId } = await emitReevaluationEvent({
        type: "POLICY_CHANGED", subjectId: testSubject,
        payload: { reason: "crash-test" }, idempotencyKey: `phase865-crash-${Date.now()}`,
      });

      // Worker A claims but "crashes" (never completes)
      const claimed = await claimReevaluationEvent("worker-crash", { subjectId: testSubject });
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(eventId);

      // Simulate lease expiry: backdate claimExpiresAt to the past
      await db.reevaluationEvent.update({
        where: { id: eventId },
        data: { claimExpiresAt: new Date(Date.now() - 1000) },
      });

      // reclaimExpiredClaims returns it to PENDING
      const reclaimResult = await reclaimExpiredClaims();
      expect(reclaimResult.reclaimed).toBeGreaterThan(0);

      // Worker B can now claim it (it's PENDING again)
      const claimedB = await claimReevaluationEvent("worker-B", { subjectId: testSubject });
      expect(claimedB).not.toBeNull();
      expect(claimedB!.id).toBe(eventId);
    }, 60_000);

    it("8.6.5.6: duplicate event emission → one event (idempotency key)", async () => {
      const key = `phase865-dup-${Date.now()}`;
      const r1 = await emitReevaluationEvent({ type: "POLICY_CHANGED", subjectId: fx.subjectId, payload: {}, idempotencyKey: key });
      const r2 = await emitReevaluationEvent({ type: "POLICY_CHANGED", subjectId: fx.subjectId, payload: {}, idempotencyKey: key });
      expect(r1.duplicate).toBe(false);
      expect(r2.duplicate).toBe(true);
      expect(r1.eventId).toBe(r2.eventId);
    }, 60_000);

    it("8.6.5.7: dead-letter after max attempts (poison-event protection)", async () => {
      // Create an event and set it to FAILED with attemptCount at the max.
      const { eventId } = await emitReevaluationEvent({
        type: "POLICY_CHANGED", subjectId: `poison-${Date.now()}`,
        payload: {}, idempotencyKey: `phase865-poison-${Date.now()}`,
      });

      // Set attemptCount to MAX and state to FAILED with expired lease.
      await db.reevaluationEvent.update({
        where: { id: eventId },
        data: { attemptCount: EVENT_MAX_ATTEMPTS, state: "FAILED", claimExpiresAt: new Date(Date.now() - 1000) },
      });

      // reclaimExpiredClaims should dead-letter it (attemptCount >= MAX).
      const reclaimResult = await reclaimExpiredClaims();
      expect(reclaimResult.deadLettered).toBeGreaterThan(0);

      const event = await db.reevaluationEvent.findUnique({ where: { id: eventId }, select: { state: true } });
      expect(event?.state).toBe("DEAD_LETTER");
    }, 60_000);
  });

  // =========================================================================
  // 5. Decision triggering separated from execution
  // =========================================================================
  describe("5. Decision triggering vs execution", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.8: reevaluation produces Decision (PENDING) without executing", async () => {
      // ACTIVATE A first
      const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
      const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `phase865-sep-${fx.sessionId}` });
      await executeAction(action.id);

      // Backdate + inject degraded measurements to trigger a SWITCH decision
      await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { startedAt: new Date(Date.now() - 120_000) } });
      await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } });
      await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});

      for (let i = 0; i < 3; i++) {
        await ingestMeasurement({
          resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
          type: "QUALITY", metrics: { throughputDownMbps: 5, latencyMs: 250, packetLossPercent: 8 },
          source: "ADAPTER", confidence: 0.8, triggerReevaluation: false,
        });
      }

      // processPendingEventsForResource EVALUATES → produces a Decision (PENDING), does NOT execute
      // (scoped to this resource to avoid iterating leftover PENDING events from other fixtures)
      const evalResult = await processPendingEventsForResource(fx.resourceAId);
      expect(evalResult).toBeGreaterThan(0);

      const switchDecision = await db.connectivityDecision.findFirst({
        where: { sessionId: fx.sessionId, action: "SWITCH" },
        orderBy: { createdAt: "desc" },
      });
      expect(switchDecision).not.toBeNull();
      // The decision is PENDING (not yet executed by the reevaluation worker)
      expect(switchDecision?.executionState).toBe("PENDING");

      // The session is still on A (no action was executed yet)
      const session = await db.connectivitySession.findUnique({ where: { id: fx.sessionId }, select: { activeResourceId: true } });
      expect(session?.activeResourceId).toBe(fx.resourceAId);

      // executeDecision turns the PENDING decision into an action (scoped to
      // this test's own decision — avoids iterating leftover PENDING decisions
      // from other fixtures, which is slow against PostgreSQL).
      const execResult = await executeDecision(switchDecision!.id);
      expect(execResult.executionState).toBe("EXECUTED");

      // Now the session is on B
      const sessionAfter = await db.connectivitySession.findUnique({ where: { id: fx.sessionId }, select: { activeResourceId: true } });
      expect(sessionAfter?.activeResourceId).toBe(fx.resourceBId);

      // The decision is now EXECUTED
      const executedDecision = await db.connectivityDecision.findUnique({ where: { id: switchDecision!.id }, select: { executionState: true } });
      expect(executedDecision?.executionState).toBe("EXECUTED");
    }, 300_000);
  });

  // =========================================================================
  // 5b. Idempotent decision execution (isolated fixture)
  // =========================================================================
  describe("5b. Idempotent decision execution", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.9: duplicate reevaluation → one decision (idempotent execution)", async () => {
      // ACTIVATE A first so the session is ACTIVE
      const activateDecision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
      const action = await createAction({ sessionId: fx.sessionId, decisionId: activateDecision.decisionId, type: "ACTIVATE", targetResourceId: activateDecision.targetResourceId, idempotencyKey: `phase865-idemp-activate-${fx.sessionId}` });
      await executeAction(action.id);

      // Create a SWITCH decision targeting B (manual, since makeDecision would return KEEP)
      const switchDecision = await db.connectivityDecision.create({
        data: {
          intentId: "phase865-idemp",
          sessionId: fx.sessionId,
          action: "SWITCH",
          targetResourceId: fx.resourceBId,
          score: 0.9,
          constraintsSatisfied: JSON.stringify(["MANUAL"]),
          constraintsViolated: JSON.stringify([]),
          reasons: JSON.stringify(["test: idempotent execution"]),
          executionState: "PENDING",
        },
      });

      // Execute it twice
      const r1 = await executeDecision(switchDecision.id);
      expect(r1.executionState).toBe("EXECUTED");

      const r2 = await executeDecision(switchDecision.id);
      expect(r2.executionState).toBe("EXECUTED"); // idempotent — returns current state

      // Only ONE action was created (idempotencyKey dedup)
      const actions = await db.connectivityAction.findMany({
        where: { decisionId: switchDecision.id },
      });
      expect(actions.length).toBe(1);
    }, 180_000);
  });

  // =========================================================================
  // 6. Observation failure does not corrupt session/action state
  // =========================================================================
  describe("6. Observation failure isolation", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.10: observation failure → session/action state intact", async () => {
      // ACTIVATE A normally
      const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
      const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `phase865-failobs-${fx.sessionId}` });
      const execResult = await executeAction(action.id);
      expect(execResult.status).toBe("succeeded");

      // Verify the session is healthy before the observation failure
      const invariantBefore = await assertActiveConnectivityInvariant(fx.sessionId);
      expect(invariantBefore.valid).toBe(true);

      // Simulate an observation failure: replace the mock adapter with one
      // that throws on getUsage(). The probe should fail gracefully.
      const { replaceConnectivityProvider } = await import("@/lib/connectivity");
      const throwingAdapter = {
        providerType: "mock",
        label: "Throwing Mock (test)",
        provision: async () => { throw new Error("provision disabled in test"); },
        suspend: async () => ({ status: "success" as const }),
        resume: async () => ({ status: "success" as const }),
        release: async () => ({ status: "success" as const }),
        getUsage: async () => { throw new Error("simulated observation failure"); },
        reconcile: async () => ({ status: "in_sync" as const, observedState: "active" as const }),
      };
      replaceConnectivityProvider(throwingAdapter as any);

      // Attempt to probe A — it should fail gracefully (adapter-getUsage-error)
      const probeResult = await probeAndIngest(fx.resourceAId, fx.sessionId);
      expect(probeResult.probed).toBe(false);
      expect(probeResult.reason).toContain("error");

      // Restore the real mock adapter
      const { mockConnectivityProvider } = await import("@/lib/connectivity");
      replaceConnectivityProvider(mockConnectivityProvider);

      // The session is still ACTIVE on A — observation failure did not corrupt it
      const session = await db.connectivitySession.findUnique({ where: { id: fx.sessionId }, select: { state: true, activeResourceId: true } });
      expect(session?.state).toBe("ACTIVE");
      expect(session?.activeResourceId).toBe(fx.resourceAId);

      // The action is still SUCCEEDED — observation failure did not corrupt it
      const actionAfter = await db.connectivityAction.findUnique({ where: { id: action.id }, select: { state: true } });
      expect(actionAfter?.state).toBe("SUCCEEDED");

      // The invariant still holds — observation failure did not corrupt state
      const invariantAfter = await assertActiveConnectivityInvariant(fx.sessionId);
      expect(invariantAfter.valid).toBe(true);
    }, 120_000);
  });

  // =========================================================================
  // 7. Closed-loop invariant — OBSERVE AGAIN after switch
  // =========================================================================
  describe("7. Closed-loop re-observation", () => {
    let fx: Fixture;
    beforeAll(async () => { fx = await setupFixture(); }, 120_000);
    afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

    it("8.6.5.11: after SWITCH, the new resource B is immediately observed", async () => {
      // ACTIVATE A
      const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
      const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `phase865-closedloop-${fx.sessionId}` });
      await executeAction(action.id);

      // The closed-loop reobservation after ACTIVATE probes A. Verify a
      // measurement exists for A.
      const aMeasurement = await db.connectivityMeasurement.findFirst({ where: { resourceId: fx.resourceAId }, orderBy: { capturedAt: "desc" } });
      expect(aMeasurement).not.toBeNull();
      expect(aMeasurement?.source).toBe("ADAPTER");

      // Now SWITCH to B
      await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { startedAt: new Date(Date.now() - 120_000) } });
      await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } });
      await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
      for (let i = 0; i < 3; i++) {
        await ingestMeasurement({
          resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
          type: "QUALITY", metrics: { throughputDownMbps: 5, latencyMs: 250, packetLossPercent: 8 },
          source: "ADAPTER", confidence: 0.8, triggerReevaluation: false,
        });
      }
      await processPendingEventsForResource(fx.resourceAId);
      // Execute the test's own SWITCH decision directly (scoped — avoids
      // iterating leftover PENDING decisions from other fixtures).
      const switchDecision = await db.connectivityDecision.findFirst({
        where: { sessionId: fx.sessionId, action: "SWITCH", executionState: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      expect(switchDecision).not.toBeNull();
      await executeDecision(switchDecision!.id);

      // Session is now on B
      const session = await db.connectivitySession.findUnique({ where: { id: fx.sessionId }, select: { activeResourceId: true, state: true } });
      expect(session?.activeResourceId).toBe(fx.resourceBId);
      expect(session?.state).toBe("ACTIVE");

      // The closed-loop reobservation after SWITCH probes B immediately.
      // Verify a measurement exists for B (OBSERVE AGAIN).
      const bMeasurement = await db.connectivityMeasurement.findFirst({ where: { resourceId: fx.resourceBId }, orderBy: { capturedAt: "desc" } });
      expect(bMeasurement).not.toBeNull();
      expect(bMeasurement?.source).toBe("ADAPTER");
    }, 300_000);
  });
});
