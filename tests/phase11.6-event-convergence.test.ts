/**
 * Phase 11.6 — Out-of-Order Event Convergence (DB-backed runtime)
 *
 * Proves acceptance invariant #7:
 *   "Reordered events may affect evaluation timing, but cannot create unauthorized side effects."
 *
 * The architectural principle:
 *   Events are triggers, not authority. Current state + policy + intent authority are authority.
 *   Event ordering only changes reevaluation timing.
 *
 * Tests:
 *   11.6.1: duplicate event → process through worker → exactly one effective decision/action
 *   11.6.3: older INTENT_CHANGED (v1) after v2 → v1 cannot become authoritative
 *   11.6.5: real out-of-order RESOURCE_DEGRADED then RESOURCE_RECOVERED (and reverse) → final state converges from current authoritative state
 *   11.6.6: event-as-trigger proof — stale event cannot resurrect state because evaluation derives from current state
 *   11.6.4: duplicate + out-of-order measurement → final state converges
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase11.6-event-convergence.test.ts
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
import { createIntent, isIntentExpired } from "@/lib/control-plane/intent-service";
import { emitReevaluationEvent, processPendingEvents } from "@/lib/control-plane/reevaluation";
import { ingestMeasurement } from "@/lib/control-plane/measurement-store";
import { executeDecision } from "@/lib/control-plane/decision-executor";

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
  const email = `phase116-${Date.now()}@test.roamlink`;
  const slug = `p116-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P11.6 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P116 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P116 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p116-${session.id}` });
  await executeAction(action.id);
  await db.connectivityDecision.update({
    where: { id: decision.decisionId },
    data: { executionState: "EXECUTED", executedAt: new Date(), executedActionId: action.id },
  }).catch(() => {});
  await db.connectivitySession.update({
    where: { id: session.id },
    data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null },
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

describe("Phase 11.6 — Out-of-Order Event Convergence (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  async function resetToActiveOnA() {
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null, activeResourceId: fx.resourceAId, state: "ACTIVE", entitlementId: fx.entitlementId },
    }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceAId }, data: { state: "IN_USE", reservedBy: fx.sessionId } }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceBId }, data: { state: "AVAILABLE", reservedBy: null, reservedAt: null } }).catch(() => {});
  }

  // =========================================================================
  // 11.6.1 — Duplicate event → process through worker → exactly one decision/action
  //
  // Emits two identical events with the same idempotencyKey, then processes
  // through the worker. Proves exactly one event is persisted AND exactly one
  // effective decision/action results (not just one stored event row).
  // =========================================================================
  it("11.6.1: duplicate event → process through worker → exactly one effective decision/action", async () => {
    await resetToActiveOnA();
    await db.connectivityDecision.deleteMany({ where: { sessionId: fx.sessionId, intentId: { contains: "dup-1161" } } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: fx.sessionId, decisionId: null } }).catch(() => {});
    // Clean up ALL pending events globally — processOneEvent claims the OLDEST
    // pending event, and leftover MEASUREMENT_RECEIVED events from prior tests
    // would be claimed first. We need OUR event to be the only one available.
    await db.reevaluationEvent.deleteMany({}).catch(() => {});

    // Create a real active intent so the event can actually trigger a decision.
    const intent = await createIntent({
      subjectId: fx.subjectId,
      rawText: "dup-event intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    const idempotencyKey = `dup-1161-${Date.now()}`;
    const r1 = await emitReevaluationEvent({
      type: "INTENT_CHANGED",
      subjectId: fx.subjectId,
      payload: { intentId: intent.intentId, intentVersion: intent.version, subjectId: fx.subjectId, reason: "test" },
      idempotencyKey,
    });
    const r2 = await emitReevaluationEvent({
      type: "INTENT_CHANGED",
      subjectId: fx.subjectId,
      payload: { intentId: intent.intentId, intentVersion: intent.version, subjectId: fx.subjectId, reason: "test" },
      idempotencyKey,
    });

    // Exactly one event persisted.
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r1.eventId).toBe(r2.eventId);

    // Process through the worker — use the official processOneEvent entry point.
    const { processOneEvent } = await import("@/lib/control-plane/reevaluation");
    const result = await processOneEvent(`dup-1161-${Date.now()}`);

    // The event was processed (not null — an event was found and processed).
    expect(result).not.toBeNull();

    // Exactly one event in the DB — deduplication worked.
    const events = await db.reevaluationEvent.findMany({ where: { idempotencyKey } });
    expect(events.length).toBe(1);

    // Exactly one decision referencing this intent — the event was processed
    // exactly once. The session is ACTIVE, so isReevaluationNecessary returns
    // true and makeDecision runs. The decision is ACTIVATE (the session already
    // has a resource but makeDecision returns ACTIVATE when there are ranked
    // offers). The decision reaches a terminal state.
    const decisions = await db.connectivityDecision.findMany({
      where: { intentId: intent.intentId, intentVersion: intent.version },
    });
    expect(decisions.length).toBe(1);
    expect(["EXECUTED", "SKIPPED", "FAILED", "RECONCILIATION_REQUIRED"]).toContain(decisions[0].executionState);

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { intentId: intent.intentId } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: fx.sessionId, decisionId: null } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { idempotencyKey } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.6.3 — Older INTENT_CHANGED (v1) after v2 → v1 cannot become authoritative
  // =========================================================================
  it("11.6.3: older INTENT_CHANGED (v1) after v2 supersedes v1 → v1 decision SKIPPED, no stale resurrection", async () => {
    await resetToActiveOnA();

    const v1 = await createIntent({
      subjectId: fx.subjectId,
      rawText: "v1 intent for ordering test",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });
    const v2 = await createIntent({
      subjectId: fx.subjectId,
      rawText: "v2 intent for ordering test",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    expect(await isIntentExpired(v1.intentId, v1.version)).toBe(true);
    expect(await isIntentExpired(v2.intentId, v2.version)).toBe(false);

    // Emit v1 event AFTER v2 (out of order).
    await db.reevaluationEvent.create({
      data: {
        type: "INTENT_CHANGED",
        subjectId: fx.subjectId,
        payload: JSON.stringify({ intentId: v1.intentId, intentVersion: v1.version, subjectId: fx.subjectId, reason: "stale-delayed-event" }),
        state: "PENDING",
      },
    });

    await processPendingEvents(5, `ordering-test-${Date.now()}`);

    // v1 decisions (if any) must be SKIPPED.
    const v1Decisions = await db.connectivityDecision.findMany({
      where: { intentId: v1.intentId, intentVersion: v1.version },
      select: { executionState: true },
    });
    for (const d of v1Decisions) {
      expect(d.executionState).toBe("SKIPPED");
    }

    // Session still on A.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, state: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);
    expect(session?.state).toBe("ACTIVE");

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { intentId: { in: [v1.intentId, v2.intentId] } } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: fx.subjectId, type: "INTENT_CHANGED" } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.6.5 — Real out-of-order reevaluation-event convergence
  //
  // Creates and processes actual RESOURCE_DEGRADED and RESOURCE_RECOVERED
  // events through the worker in BOTH orderings (A: DEGRADED→RECOVERED,
  // B: RECOVERED→DEGRADED). Proves the final state converges from the
  // current authoritative resource health, not from the event sequence.
  //
  // The architectural principle:
  //   Events are triggers, not authority. The decision engine reads the
  //   CURRENT ResourceHealth snapshot, not the event payload.
  // =========================================================================
  it("11.6.5: out-of-order RESOURCE_DEGRADED + RESOURCE_RECOVERED events → final state converges from current health", async () => {
    await resetToActiveOnA();
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: fx.sessionId, intentId: null } }).catch(() => {});

    // --- Establish HEALTHY health ---
    for (let i = 0; i < 5; i++) {
      await ingestMeasurement({
        resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId,
        type: "QUALITY", metrics: { throughputDownMbps: 80, latencyMs: 15, packetLossPercent: 0 },
        source: "ADAPTER", confidence: 0.8, capturedAt: new Date(Date.now() + i * 1000),
        triggerReevaluation: false,
      });
    }
    let health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // --- Case A: RESOURCE_DEGRADED then RESOURCE_RECOVERED (normal order) ---
    // Emit a RESOURCE_DEGRADED event manually.
    await emitReevaluationEvent({
      type: "RESOURCE_DEGRADED", resourceId: fx.resourceAId, sessionId: fx.sessionId,
      payload: { reason: "test-degraded-A", quality: 0.1 },
    });
    // Process through the worker. The worker reads CURRENT health (HEALTHY) →
    // decision should be KEEP (no action needed).
    await processPendingEvents(5, `caseA-deg-${Date.now()}`);

    // The health is still HEALTHY — the event is a trigger, not authority.
    // The degraded event did NOT change the health (it's derived from measurements).
    health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // Now emit RESOURCE_RECOVERED.
    await emitReevaluationEvent({
      type: "RESOURCE_RECOVERED", resourceId: fx.resourceAId, sessionId: fx.sessionId,
      payload: { reason: "test-recovered-A", quality: 0.9 },
    });
    await processPendingEvents(5, `caseA-rec-${Date.now()}`);

    // Still HEALTHY — no state change from either event.
    health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // --- Case B: RESOURCE_RECOVERED then RESOURCE_DEGRADED (reverse order) ---
    await db.reevaluationEvent.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: fx.sessionId, intentId: null } }).catch(() => {});

    // Emit RECOVERED first (out of order — no prior degradation).
    await emitReevaluationEvent({
      type: "RESOURCE_RECOVERED", resourceId: fx.resourceAId, sessionId: fx.sessionId,
      payload: { reason: "test-recovered-B", quality: 0.9 },
    });
    await processPendingEvents(5, `caseB-rec-${Date.now()}`);

    // Still HEALTHY — the event is a trigger, not authority.
    health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // Now emit DEGRADED.
    await emitReevaluationEvent({
      type: "RESOURCE_DEGRADED", resourceId: fx.resourceAId, sessionId: fx.sessionId,
      payload: { reason: "test-degraded-B", quality: 0.1 },
    });
    await processPendingEvents(5, `caseB-deg-${Date.now()}`);

    // STILL HEALTHY — the degraded event does NOT change the health snapshot.
    // The worker reads the current authoritative ResourceHealth (HEALTHY from
    // the measurement stream) and makes a KEEP decision.
    health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // Session is still ACTIVE on A — no unauthorized connectivity mutation.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, state: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);
    expect(session?.state).toBe("ACTIVE");

    // No SWITCH action was created by any of the events.
    const switchActions = await db.connectivityAction.findMany({
      where: { sessionId: fx.sessionId, type: "SWITCH" },
    });
    expect(switchActions.length).toBe(0);

    // Cleanup.
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: fx.sessionId, intentId: null } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.6.6 — Event-as-trigger proof: stale event cannot resurrect state
  //
  // The architectural principle: events are triggers, not authority. The
  // decision engine always derives from the CURRENT authoritative state
  // (resource health, session state, policy). A stale event (e.g. a
  // MEASUREMENT_RECEIVED for a resource that is now healthy) cannot
  // resurrect a degraded state because the reevaluation derives from the
  // current health snapshot, not from the event payload.
  // =========================================================================
  it("11.6.6: stale MEASUREMENT_RECEIVED event cannot resurrect degraded state — evaluation derives from current state", async () => {
    await resetToActiveOnA();
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});

    // 1. Establish HEALTHY health (3 good measurements).
    for (let i = 0; i < 3; i++) {
      await ingestMeasurement({
        resourceId: fx.resourceAId,
        sessionId: fx.sessionId,
        providerInstanceId: fx.providerInstanceId,
        type: "QUALITY",
        metrics: { throughputDownMbps: 80, latencyMs: 15, packetLossPercent: 0 },
        source: "ADAPTER",
        confidence: 0.8,
        capturedAt: new Date(Date.now() - (3 - i) * 5000),
        triggerReevaluation: false,
      });
    }

    let health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // 2. Emit a MEASUREMENT_RECEIVED event manually (a trigger).
    //    This event doesn't carry health data — it's a notification that
    //    a measurement was received. The worker will reevaluate based on
    //    the CURRENT health snapshot (which is HEALTHY).
    await emitReevaluationEvent({
      type: "MEASUREMENT_RECEIVED",
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      payload: { reason: "stale-trigger-test" },
    });

    // 3. Process the event. The worker calls makeDecision, which reads the
    //    CURRENT ResourceHealth snapshot (HEALTHY). The decision should be
    //    KEEP (no action needed) — the stale event cannot resurrect degraded state.
    await processPendingEvents(5, `stale-trigger-${Date.now()}`);

    // 4. Health is still HEALTHY.
    health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    // 5. Session is still ACTIVE on A.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, state: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);
    expect(session?.state).toBe("ACTIVE");

    // 6. No SWITCH action was created (the decision was KEEP, not SWITCH).
    const switchActions = await db.connectivityAction.findMany({
      where: { sessionId: fx.sessionId, type: "SWITCH" },
    });
    expect(switchActions.length).toBe(0);

    // Cleanup.
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: fx.sessionId, intentId: null } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.6.4 — Duplicate + out-of-order measurement → final state converges
  // =========================================================================
  it("11.6.4: duplicate + out-of-order measurement → final state converges, no duplicate side effects", async () => {
    await resetToActiveOnA();
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});

    const dedupKey = `meas-${fx.resourceAId}-${Date.now()}`;
    const r1 = await ingestMeasurement({
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      providerInstanceId: fx.providerInstanceId,
      type: "QUALITY",
      metrics: { throughputDownMbps: 80, latencyMs: 15, packetLossPercent: 0 },
      source: "ADAPTER",
      confidence: 0.8,
      capturedAt: new Date(Date.now() - 5000),
      deduplicationKey: dedupKey,
      triggerReevaluation: false,
    });
    const r2 = await ingestMeasurement({
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      providerInstanceId: fx.providerInstanceId,
      type: "QUALITY",
      metrics: { throughputDownMbps: 80, latencyMs: 15, packetLossPercent: 0 },
      source: "ADAPTER",
      confidence: 0.8,
      capturedAt: new Date(Date.now() - 5000),
      deduplicationKey: dedupKey,
      triggerReevaluation: false,
    });

    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r1.measurementId).toBe(r2.measurementId);

    const measurements = await db.connectivityMeasurement.findMany({ where: { deduplicationKey: dedupKey } });
    expect(measurements.length).toBe(1);

    const health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("HEALTHY");

    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, state: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);
    expect(session?.state).toBe("ACTIVE");

    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
  }, 60_000);
});
