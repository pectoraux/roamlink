/**
 * Phase 9.1 — Edge Observation Contract (DB-backed runtime)
 *
 * Proves the edge observation contract against the real database + control plane:
 *
 *   9.1.1  valid observation → persisted
 *   9.1.2  duplicate observation → one measurement (dedup)
 *   9.1.3  out-of-order sequence → accepted without duplication
 *   9.1.4  unauthorized device/session → rejected
 *   9.1.5  device cannot impersonate resource/session
 *   9.1.6  offline observations → durable outbox → eventual batch upload
 *   9.1.7  partial upload → acknowledged removed, unacknowledged retained
 *   9.1.8  observation creates normal MEASUREMENT_RECEIVED event
 *   9.1.9  mobile observation never directly invokes decision/action/kernel
 *   9.1.10 server derives measurement/health; client cannot submit health/decision
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase9.1-edge-observation.test.ts
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
import {
  registerEdgeDevice,
  ingestEdgeObservationBatch,
} from "@/lib/control-plane/edge-ingestion";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";
import type { EdgeObservation, EdgeObservationBatch } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  userId: string;
  tenantId: string;
  subjectId: string;
  resourceAId: string;
  resourceBId: string;
  entitlementId: string;
  providerInstanceId: string;
  sessionId: string;
  deviceId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase91-${Date.now()}@test.roamlink`;
  const slug = `phase91-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "Phase 9.1 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });

  // The subjectId IS the user ID — the control plane uses userId as subjectId
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P91 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found — run db:seed");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P91 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });
  const capB = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
  const resB = await db.protocolResource.create({ data: { capabilityId: capB.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "B" }), capacity: JSON.stringify({ totalBandwidthMbps: 300 }), state: "AVAILABLE" } });

  // Provision mock resources
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

  // Register the edge device
  const deviceId = `test-device-${Date.now().toString(36)}`;
  await registerEdgeDevice({ userId: user.id, deviceId, platform: "android", appVersion: "0.1.0" });

  const cleanup = async () => {
    await db.edgeObservationRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.edgeDevice.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
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

  return {
    userId: user.id, tenantId: tenant.id, subjectId,
    resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id,
    providerInstanceId: pi.id, sessionId: session.id, deviceId, cleanup,
  };
}

// Helper: build an observation
function makeObservation(fx: Fixture, overrides: Partial<EdgeObservation> = {}): EdgeObservation {
  const seq = overrides.sequence ?? Math.floor(Math.random() * 100000);
  return {
    observationId: `obs-${fx.deviceId}-${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    deviceId: fx.deviceId,
    sessionId: fx.sessionId,
    resourceId: fx.resourceAId,
    observedAt: new Date().toISOString(),
    sequence: seq,
    source: "DEVICE",
    connectivity: {
      transport: "WIFI",
      connected: true,
      downlinkMbps: 50,
      uplinkMbps: 10,
      latencyMs: 20,
      packetLossPct: 0,
      signalQuality: 0.9,
    },
    device: {
      platform: "android",
      appVersion: "0.1.0",
      networkTransport: "WIFI",
      roaming: false,
      metered: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 9.1 — Edge Observation Contract (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // =========================================================================
  // 9.1.1 valid observation → persisted
  // =========================================================================
  it("9.1.1: valid observation → persisted as immutable record", async () => {
    // ACTIVATE A first so there's an active session + resource to observe
    const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
    const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `p91-activate-${fx.sessionId}` });
    await executeAction(action.id);

    const obs = makeObservation(fx, { sequence: 1001 });
    const batch: EdgeObservationBatch = { deviceId: fx.deviceId, observations: [obs] };
    const ack = await ingestEdgeObservationBatch(fx.userId, batch);

    expect(ack.acceptedThroughSequence).toBe(1001);
    expect(ack.duplicateCount).toBe(0);
    expect(ack.rejected).toHaveLength(0);

    // The observation record is persisted
    const record = await db.edgeObservationRecord.findUnique({ where: { observationId: obs.observationId } });
    expect(record).not.toBeNull();
    expect(record?.userId).toBe(fx.userId);
    expect(record?.resourceId).toBe(fx.resourceAId); // validated hint accepted
  }, 60_000);

  // =========================================================================
  // 9.1.2 duplicate observation → one measurement (dedup)
  // =========================================================================
  it("9.1.2: duplicate observation (same observationId) → one measurement", async () => {
    const obs = makeObservation(fx, { sequence: 1002 });

    const ack1 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });
    const ack2 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });

    expect(ack1.duplicateCount).toBe(0);
    expect(ack2.duplicateCount).toBe(1); // second upload is a duplicate
    expect(ack2.acceptedThroughSequence).toBe(1002);

    // Only one observation record exists
    const count = await db.edgeObservationRecord.count({ where: { observationId: obs.observationId } });
    expect(count).toBe(1);
  }, 60_000);

  // =========================================================================
  // 9.1.3 out-of-order sequence → accepted without duplication
  // =========================================================================
  it("9.1.3: out-of-order sequence → accepted without duplication", async () => {
    const obs101 = makeObservation(fx, { sequence: 101, observationId: `oob-101-${Date.now()}` });
    const obs103 = makeObservation(fx, { sequence: 103, observationId: `oob-103-${Date.now()}` });
    const obs102 = makeObservation(fx, { sequence: 102, observationId: `oob-102-${Date.now()}` });

    // Upload out of order: 101, 103, 102
    const ack1 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs101, obs103] });
    const ack2 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs102] });

    // ack1 accepted 101 + 103 → watermark is 103
    expect(ack1.acceptedThroughSequence).toBe(103);
    // ack2 accepted 102 → watermark is 102 (the max in THIS batch, not cumulative)
    expect(ack2.acceptedThroughSequence).toBe(102);
    expect(ack1.duplicateCount + ack2.duplicateCount).toBe(0);

    // All three persisted
    const records = await db.edgeObservationRecord.count({ where: { observationId: { in: [obs101.observationId, obs102.observationId, obs103.observationId] } } });
    expect(records).toBe(3);
  }, 60_000);

  // =========================================================================
  // 9.1.4 unauthorized device → rejected
  // =========================================================================
  it("9.1.4: unauthorized device (not registered to user) → rejected", async () => {
    const obs = makeObservation(fx, { sequence: 200, deviceId: "unknown-device" });

    await expect(
      ingestEdgeObservationBatch(fx.userId, { deviceId: "unknown-device", observations: [obs] }),
    ).rejects.toThrow(/Unknown device|register/i);
  }, 30_000);

  // =========================================================================
  // 9.1.5 device cannot impersonate resource/session
  // =========================================================================
  it("9.1.5: device-supplied resourceId is validated (hint, not authoritative)", async () => {
    // Observation with a resourceId that doesn't match the session's active resource
    // The hint is dropped (set to null), but the observation is still accepted.
    const obs = makeObservation(fx, { sequence: 300, resourceId: "fake-resource-id" });
    const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });

    expect(ack.acceptedThroughSequence).toBe(300);

    // The record's resourceId is NULL (hint was invalid → dropped)
    const record = await db.edgeObservationRecord.findUnique({ where: { observationId: obs.observationId } });
    expect(record?.resourceId).toBeNull(); // hint dropped
  }, 30_000);

  it("9.1.5b: device cannot impersonate another user's session", async () => {
    // Observation with a sessionId belonging to a different user
    const obs = makeObservation(fx, { sequence: 301, sessionId: "other-user-session" });
    const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });

    // The session hint is dropped (validated to null)
    const record = await db.edgeObservationRecord.findUnique({ where: { observationId: obs.observationId } });
    expect(record?.sessionId).toBeNull();
  }, 30_000);

  // =========================================================================
  // 9.1.6 offline observations → batch upload (simulated)
  // =========================================================================
  it("9.1.6: batch of observations → all accepted in one upload", async () => {
    const observations = Array.from({ length: 5 }, (_, i) =>
      makeObservation(fx, { sequence: 400 + i, observationId: `batch-${400 + i}-${Date.now()}` }),
    );

    const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations });

    expect(ack.acceptedThroughSequence).toBe(404);
    expect(ack.duplicateCount).toBe(0);
    expect(ack.rejected).toHaveLength(0);

    // All 5 persisted
    const count = await db.edgeObservationRecord.count({
      where: { observationId: { in: observations.map((o) => o.observationId) } },
    });
    expect(count).toBe(5);
  }, 60_000);

  // =========================================================================
  // 9.1.7 partial upload → acknowledged removed (simulated via dedup)
  // =========================================================================
  it("9.1.7: re-upload of acknowledged observations → duplicates detected", async () => {
    const obs = makeObservation(fx, { sequence: 500, observationId: `partial-500-${Date.now()}` });

    // First upload — accepted
    const ack1 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });
    expect(ack1.duplicateCount).toBe(0);

    // Second upload of the same observation — duplicate
    const ack2 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });
    expect(ack2.duplicateCount).toBe(1);

    // A new observation in the same batch — accepted
    const obs2 = makeObservation(fx, { sequence: 501, observationId: `partial-501-${Date.now()}` });
    const ack3 = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs, obs2] });
    expect(ack3.duplicateCount).toBe(1); // obs is duplicate
    expect(ack3.acceptedThroughSequence).toBe(501); // obs2 accepted
  }, 60_000);

  // =========================================================================
  // 9.1.8 observation creates MEASUREMENT_RECEIVED event
  // =========================================================================
  it("9.1.8: observation with valid resourceId → ConnectivityMeasurement + MEASUREMENT_RECEIVED event", async () => {
    const eventsBefore = await db.reevaluationEvent.count({ where: { resourceId: fx.resourceAId } });

    const obs = makeObservation(fx, { sequence: 600, observationId: `event-600-${Date.now()}` });
    await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });

    // A MEASUREMENT_RECEIVED event was emitted for the resource
    const eventsAfter = await db.reevaluationEvent.count({ where: { resourceId: fx.resourceAId } });
    expect(eventsAfter).toBeGreaterThan(eventsBefore);

    // The observation record is linked to a derived measurement
    const record = await db.edgeObservationRecord.findUnique({ where: { observationId: obs.observationId } });
    expect(record?.derivedMeasurementId).not.toBeNull();

    // The measurement has source=DEVICE (provenance preserved)
    const measurement = await db.connectivityMeasurement.findUnique({ where: { id: record!.derivedMeasurementId! } });
    expect(measurement?.source).toBe("DEVICE");
  }, 60_000);

  // =========================================================================
  // 9.1.9 mobile observation never directly invokes decision/action/kernel
  // =========================================================================
  it("9.1.9: observation does NOT directly create actions (only telemetry)", async () => {
    const actionsBefore = await db.connectivityAction.count({ where: { sessionId: fx.sessionId } });

    const obs = makeObservation(fx, { sequence: 700, observationId: `noaction-700-${Date.now()}` });
    await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });

    // No new ACTIONS were created by the observation directly. The observation
    // is telemetry — it feeds the control plane (measurement → health →
    // reevaluation → decision → action), but the edge ingestion itself does
    // NOT call the action executor. A KEEP decision from reevaluation is fine
    // (that's the control plane deciding "no action needed"), but no ACTION
    // rows should be created by the observation itself.
    const actionsAfter = await db.connectivityAction.count({ where: { sessionId: fx.sessionId } });
    expect(actionsAfter).toBe(actionsBefore);

    // The observation only created a measurement (telemetry), not an action
    const record = await db.edgeObservationRecord.findUnique({ where: { observationId: obs.observationId } });
    expect(record).not.toBeNull();
  }, 60_000);

  // =========================================================================
  // 9.1.10 server derives measurement/health; client cannot submit health/decision
  // =========================================================================
  it("9.1.10: client-submitted health/decision fields are ignored — server derives", async () => {
    // The observation type has NO health/decision fields. The client can only
    // submit connectivity state. The server derives health via ResourceHealth.
    const obs = makeObservation(fx, { sequence: 800, observationId: `derive-800-${Date.now()}` });

    // Attempt to inject a fake health score (the type doesn't allow it, but
    // simulate via extra fields that the server should ignore)
    const obsWithJunk = { ...obs, healthScore: 0.99, decision: "SWITCH" } as EdgeObservation;

    const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obsWithJunk] });
    expect(ack.acceptedThroughSequence).toBe(800);

    // The server-derived measurement exists (source=DEVICE)
    const record = await db.edgeObservationRecord.findUnique({ where: { observationId: obs.observationId } });
    expect(record?.derivedMeasurementId).not.toBeNull();

    // ResourceHealth is derived by the server (not submitted by the client)
    const health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    // Health exists (server-derived from the measurement stream)
    expect(health).not.toBeNull();
    // The health status is NOT a client-submitted 0.99 — it's server-derived
    expect(["HEALTHY", "DEGRADED", "UNKNOWN"]).toContain(health?.status);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// North-star: mobile observe degraded → measurement → health → reevaluation
// ===========================================================================
describe("Phase 9.1 — North-star: edge observation → control plane", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  it("9.1.NS: mobile observes degraded WiFi → ResourceHealth DEGRADED via control plane", async () => {
    // 1. ACTIVATE A
    const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.subjectId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
    const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `p91-ns-${fx.sessionId}` });
    await executeAction(action.id);

    // Backdate startedAt so dwell gate passes
    await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { startedAt: new Date(Date.now() - 120_000) } });

    // Clear auto-probe measurements so health reflects only the device observations
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});

    // 2. Mobile observes degraded WiFi 3 times
    for (let i = 0; i < 3; i++) {
      const obs = makeObservation(fx, {
        sequence: 900 + i,
        observationId: `ns-degraded-${900 + i}-${Date.now()}`,
        connectivity: {
          transport: "WIFI",
          connected: true,
          downlinkMbps: 3, // very low throughput
          uplinkMbps: 0.5,
          latencyMs: 250,
          packetLossPct: 8,
          signalQuality: 0.1,
        },
      });
      const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: fx.deviceId, observations: [obs] });
      expect(ack.rejected).toHaveLength(0);
    }

    // 3. The server derived ResourceHealth = DEGRADED from the device observations
    const health = await db.resourceHealth.findUnique({ where: { resourceId: fx.resourceAId } });
    expect(health?.status).toBe("DEGRADED");
    expect(health?.derivedFromSources).toContain("DEVICE"); // provenance preserved

    // 4. A MEASUREMENT_RECEIVED event was emitted (feeding reevaluation)
    const event = await db.reevaluationEvent.findFirst({
      where: { resourceId: fx.resourceAId, type: "MEASUREMENT_RECEIVED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
  }, 120_000);
});
