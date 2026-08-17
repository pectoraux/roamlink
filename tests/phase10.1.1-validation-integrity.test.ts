/**
 * Phase 10.1.1 — Observation Validation Integrity Fixes (DB-backed)
 *
 * Proves the four corrective closures identified in the architect's audit of
 * fad2f0d. Each test exercises the ACTUAL edge-ingestion pipeline
 * (ingestEdgeObservationBatch → ingestOneObservation → validateObservation →
 * ingestMeasurement), not just the unit-level validateObservation() surface.
 *
 *   10.1.1.1  Resource hint mismatch → measurement persisted with
 *             integrity=RESOURCE_MISMATCH, trust=UNTRUSTED (auditable, excluded
 *             from health). Previously the mismatch was silently cleared and
 *             no measurement was projected.
 *
 *   10.1.1.2  Per-device rate limiting. Device A floods 60 observations → the
 *             61st is classified RATE_LIMITED + UNTRUSTED. Device B (separate
 *             bucket) can still submit VALID observations. Previously the
 *             counter was keyed by (resourceId, source) so two devices on the
 *             same resource shared a bucket, and a device could evade by
 *             switching resource context.
 *
 *   10.1.1.3  Duplicate semantics. A duplicate observation is an INGESTION
 *             OUTCOME (ack.duplicateCount=1), NOT a measurement-integrity
 *             state. No persisted measurement carries integrity=DUPLICATE.
 *             The original measurement retains its VALID/LIMITED classification.
 *
 *   10.1.1.4  Measurement projection through the actual ingestion path. A
 *             valid device observation through ingestEdgeObservationBatch
 *             projects a ConnectivityMeasurement (count > 0). Previously the
 *             undefined `input.triggerReevaluation` reference threw a
 *             ReferenceError that was silently swallowed by the try/catch,
 *             so no measurement was ever projected for device observations.
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase10.1.1-validation-integrity.test.ts
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
  registerEdgeDevice,
  ingestEdgeObservationBatch,
} from "@/lib/control-plane/edge-ingestion";
import { getResourceHealth } from "@/lib/control-plane/health-derivation";
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
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase1011-${Date.now()}@test.roamlink`;
  const slug = `p1011-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P10.1.1 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P1011 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P1011 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  // ACTIVATE resource A so the session has an active resource to validate hints against.
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p1011-${session.id}` });
  await executeAction(action.id);

  const cleanup = async () => {
    await db.edgeObservationRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.edgeDevice.deleteMany({ where: { userId: user.id } }).catch(() => {});
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

  return { userId: user.id, tenantId: tenant.id, subjectId, resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, cleanup };
}

function makeObs(deviceId: string, seq: number, overrides: Partial<EdgeObservation> = {}): EdgeObservation {
  return {
    observationId: `obs-${deviceId}-${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    deviceId,
    observedAt: new Date().toISOString(),
    sequence: seq,
    source: "DEVICE",
    connectivity: { transport: "WIFI", connected: true, downlinkMbps: 50, uplinkMbps: 10, latencyMs: 20, packetLossPct: 0, signalQuality: 0.9 },
    device: { platform: "android", appVersion: "0.1.0", networkTransport: "WIFI", roaming: false, metered: false },
    ...overrides,
  };
}

let devCounter = 0;
async function freshDevice(userId: string): Promise<string> {
  const deviceId = `p1011-dev-${Date.now().toString(36)}-${devCounter++}`;
  await registerEdgeDevice({ userId, deviceId, platform: "android", appVersion: "0.1.0" });
  return deviceId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 10.1.1 — Observation Validation Integrity Fixes (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupFixture();
  }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // =========================================================================
  // 10.1.1.1 — Resource hint mismatch → RESOURCE_MISMATCH + UNTRUSTED persisted
  // =========================================================================
  it("10.1.1.1: resource hint mismatch → measurement persisted with RESOURCE_MISMATCH + UNTRUSTED (auditable, excluded from health)", async () => {
    const dev = await freshDevice(fx.userId);

    // The session's active resource is A (activated in the fixture).
    // The device claims resource B (a real resource, but not the session's active one).
    const obs = makeObs(dev, 1, { sessionId: fx.sessionId, resourceId: fx.resourceBId });

    const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: dev, observations: [obs] });

    // Accepted (the observation is persisted for audit, not rejected).
    expect(ack.rejected.length).toBe(0);

    // The observation record is persisted.
    const record = await db.edgeObservationRecord.findUnique({
      where: { observationId: obs.observationId },
      select: { id: true, resourceId: true, derivedMeasurementId: true },
    });
    expect(record).not.toBeNull();
    // Phase 10.1.1: the observation record's resourceId is the SESSION'S active
    // resource (A), not the bogus hint (B). The mismatch is preserved on the
    // projected measurement's integrity field, not by silently clearing the hint.
    expect(record?.resourceId).toBe(fx.resourceAId);

    // The projected measurement is persisted with RESOURCE_MISMATCH + UNTRUSTED.
    expect(record?.derivedMeasurementId).not.toBeNull();
    const measurement = await db.connectivityMeasurement.findUnique({
      where: { id: record!.derivedMeasurementId! },
      select: { integrity: true, trust: true, resourceId: true },
    });
    expect(measurement?.integrity).toBe("RESOURCE_MISMATCH");
    expect(measurement?.trust).toBe("UNTRUSTED");
    // The measurement is attached to the session's actual active resource (A).
    expect(measurement?.resourceId).toBe(fx.resourceAId);

    // Health firewall: the UNTRUSTED measurement does NOT influence health.
    // Resource A's health should not be upgraded to HEALTHY by this untrusted
    // observation. (It may be UNKNOWN or DEGRADED depending on prior state,
    // but it must not be HEALTHY solely from this UNTRUSTED measurement.)
    const health = await getResourceHealth(fx.resourceAId);
    if (health?.status === "HEALTHY") {
      // If HEALTHY, it must be from TRUSTED or LIMITED evidence, not UNTRUSTED.
      expect(health.trust).not.toBe("UNTRUSTED");
    }
  }, 60_000);

  // =========================================================================
  // 10.1.1.2 — Per-device rate limiting (separate buckets per device)
  // =========================================================================
  it("10.1.1.2: per-device rate limit — device A floods 60, 61st is RATE_LIMITED; device B unaffected", async () => {
    const devA = await freshDevice(fx.userId);
    const devB = await freshDevice(fx.userId);

    // Pre-insert 60 EdgeObservationRecord rows for device A (raw DB inserts,
    // within the 60s rate-limit window). After this, device A has 60 records.
    // The 61st observation (submitted next) will make the count 61 — the first
    // to exceed the limit. (The exact 60th/61st boundary is proven separately
    // in test 10.1.1.5.)
    const now = Date.now();
    await db.edgeObservationRecord.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        observationId: `flood-${devA}-${i}-${now}`,
        deviceId: devA,
        userId: fx.userId,
        sessionId: fx.sessionId,
        resourceId: fx.resourceAId,
        sequence: 1000 + i, // high sequence to avoid colliding with the real test observation
        source: "DEVICE",
        observedAt: new Date(now),
        payload: JSON.stringify({ flooded: true }),
      })),
    });

    // Device A's 61st observation (through the real ingestion path) → RATE_LIMITED.
    const obs61 = makeObs(devA, 2000, { sessionId: fx.sessionId, resourceId: fx.resourceAId });
    const ack61 = await ingestEdgeObservationBatch(fx.userId, { deviceId: devA, observations: [obs61] });
    expect(ack61.rejected.length).toBe(0); // accepted (persisted for audit), but classified RATE_LIMITED

    const record61 = await db.edgeObservationRecord.findUnique({
      where: { observationId: obs61.observationId },
      select: { derivedMeasurementId: true },
    });
    expect(record61?.derivedMeasurementId).not.toBeNull();
    const measurement61 = await db.connectivityMeasurement.findUnique({
      where: { id: record61!.derivedMeasurementId! },
      select: { integrity: true, trust: true },
    });
    expect(measurement61?.integrity).toBe("RATE_LIMITED");
    expect(measurement61?.trust).toBe("UNTRUSTED");

    // Device B's first observation → VALID + LIMITED (separate bucket).
    const obsB = makeObs(devB, 1, { sessionId: fx.sessionId, resourceId: fx.resourceAId });
    const ackB = await ingestEdgeObservationBatch(fx.userId, { deviceId: devB, observations: [obsB] });
    expect(ackB.rejected.length).toBe(0);

    const recordB = await db.edgeObservationRecord.findUnique({
      where: { observationId: obsB.observationId },
      select: { derivedMeasurementId: true },
    });
    expect(recordB?.derivedMeasurementId).not.toBeNull();
    const measurementB = await db.connectivityMeasurement.findUnique({
      where: { id: recordB!.derivedMeasurementId! },
      select: { integrity: true, trust: true },
    });
    // Device B is NOT rate-limited (separate per-device bucket).
    expect(measurementB?.integrity).not.toBe("RATE_LIMITED");
    expect(measurementB?.trust).not.toBe("UNTRUSTED");

    // Cleanup the flood records so they don't affect other tests.
    await db.connectivityMeasurement.deleteMany({
      where: { resourceId: fx.resourceAId, source: "DEVICE", trust: "UNTRUSTED" },
    }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
  }, 90_000);

  // =========================================================================
  // 10.1.1.3 — Duplicate is an ingestion outcome, NOT a measurement integrity
  // =========================================================================
  it("10.1.1.3: duplicate observation → ingestion outcome (ack.duplicateCount), no measurement with integrity=DUPLICATE", async () => {
    const dev = await freshDevice(fx.userId);

    // Submit a valid observation.
    const obs = makeObs(dev, 1, { sessionId: fx.sessionId, resourceId: fx.resourceAId });
    const ack1 = await ingestEdgeObservationBatch(fx.userId, { deviceId: dev, observations: [obs] });
    expect(ack1.duplicateCount).toBe(0);

    // The first ingestion projects a measurement with VALID + LIMITED.
    const record1 = await db.edgeObservationRecord.findUnique({
      where: { observationId: obs.observationId },
      select: { derivedMeasurementId: true },
    });
    expect(record1?.derivedMeasurementId).not.toBeNull();
    const measurement1 = await db.connectivityMeasurement.findUnique({
      where: { id: record1!.derivedMeasurementId! },
      select: { integrity: true, trust: true },
    });
    expect(measurement1?.integrity).toBe("VALID");
    expect(measurement1?.trust).toBe("LIMITED");

    // Re-submit the same observation (same observationId) → duplicate.
    const ack2 = await ingestEdgeObservationBatch(fx.userId, { deviceId: dev, observations: [obs] });
    expect(ack2.duplicateCount).toBe(1);

    // No measurement with integrity=DUPLICATE exists (DUPLICATE is NOT a
    // measurement-integrity state — it's an ingestion outcome).
    const duplicateMeasurements = await db.connectivityMeasurement.count({
      where: { integrity: "DUPLICATE" },
    });
    expect(duplicateMeasurements).toBe(0);

    // The original measurement retains its VALID + LIMITED classification.
    const measurement1After = await db.connectivityMeasurement.findUnique({
      where: { id: record1!.derivedMeasurementId! },
      select: { integrity: true, trust: true },
    });
    expect(measurement1After?.integrity).toBe("VALID");
    expect(measurement1After?.trust).toBe("LIMITED");
  }, 60_000);

  // =========================================================================
  // 10.1.1.4 — Measurement projection through the actual ingestion path
  //             (proves the undefined `input.triggerReevaluation` fix)
  // =========================================================================
  it("10.1.1.4: valid device observation through ingestEdgeObservationBatch → measurement projected (input.triggerReevaluation fix)", async () => {
    const dev = await freshDevice(fx.userId);

    // Capture the measurement count before.
    const beforeCount = await db.connectivityMeasurement.count({
      where: { resourceId: fx.resourceAId, source: "DEVICE" },
    });

    // Submit a valid observation through the ACTUAL ingestion path.
    const obs = makeObs(dev, 1, { sessionId: fx.sessionId, resourceId: fx.resourceAId });
    const ack = await ingestEdgeObservationBatch(fx.userId, { deviceId: dev, observations: [obs] });

    expect(ack.rejected.length).toBe(0);

    // The observation record is linked to a derived measurement.
    const record = await db.edgeObservationRecord.findUnique({
      where: { observationId: obs.observationId },
      select: { derivedMeasurementId: true },
    });
    expect(record?.derivedMeasurementId).not.toBeNull();

    // A NEW ConnectivityMeasurement was projected (count increased).
    const afterCount = await db.connectivityMeasurement.count({
      where: { resourceId: fx.resourceAId, source: "DEVICE" },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // The projected measurement has VALID + LIMITED classification (not UNTRUSTED).
    const measurement = await db.connectivityMeasurement.findUnique({
      where: { id: record!.derivedMeasurementId! },
      select: { integrity: true, trust: true, source: true },
    });
    expect(measurement?.source).toBe("DEVICE");
    expect(measurement?.integrity).toBe("VALID");
    expect(measurement?.trust).toBe("LIMITED");
  }, 60_000);

  // =========================================================================
  // 10.1.1.5 — Exact rate-limit boundary: 60th = VALID, 61st = RATE_LIMITED
  // =========================================================================
  it("10.1.1.5: exact rate-limit boundary — 60th observation is VALID, 61st is the first RATE_LIMITED", async () => {
    const dev = await freshDevice(fx.userId);

    // Pre-insert 59 EdgeObservationRecord rows for this device (raw DB inserts,
    // within the 60s rate-limit window, high sequence numbers to avoid collision).
    // After this, the device has 59 records. The 60th observation (submitted next)
    // will make the count 60 — which must be VALID (within the limit).
    const now = Date.now();
    await db.edgeObservationRecord.createMany({
      data: Array.from({ length: 59 }, (_, i) => ({
        observationId: `boundary-${dev}-${i}-${now}`,
        deviceId: dev,
        userId: fx.userId,
        sessionId: fx.sessionId,
        resourceId: fx.resourceAId,
        sequence: 5000 + i,
        source: "DEVICE",
        observedAt: new Date(now),
        payload: JSON.stringify({ boundary: true }),
      })),
    });

    // --- The 60th observation (through the real ingestion path) ---
    // The pipeline creates the record (count becomes 60), then calls
    // validateObservation which counts 60. With the off-by-one fix (strictly >),
    // 60 > 60 = false → VALID. The 60th is the LAST observation within the limit.
    const obs60 = makeObs(dev, 6000, { sessionId: fx.sessionId, resourceId: fx.resourceAId });
    const ack60 = await ingestEdgeObservationBatch(fx.userId, { deviceId: dev, observations: [obs60] });
    expect(ack60.rejected.length).toBe(0); // accepted

    const record60 = await db.edgeObservationRecord.findUnique({
      where: { observationId: obs60.observationId },
      select: { derivedMeasurementId: true },
    });
    expect(record60?.derivedMeasurementId).not.toBeNull();
    const measurement60 = await db.connectivityMeasurement.findUnique({
      where: { id: record60!.derivedMeasurementId! },
      select: { integrity: true, trust: true },
    });
    // The 60th is VALID — within the limit. NOT RATE_LIMITED.
    expect(measurement60?.integrity).toBe("VALID");
    expect(measurement60?.trust).toBe("LIMITED");

    // --- The 61st observation (through the real ingestion path) ---
    // The pipeline creates the record (count becomes 61), then calls
    // validateObservation which counts 61. 61 > 60 = true → RATE_LIMITED.
    // The 61st is the FIRST observation to exceed the limit.
    const obs61 = makeObs(dev, 6001, { sessionId: fx.sessionId, resourceId: fx.resourceAId });
    const ack61 = await ingestEdgeObservationBatch(fx.userId, { deviceId: dev, observations: [obs61] });
    expect(ack61.rejected.length).toBe(0); // accepted (persisted for audit)

    const record61 = await db.edgeObservationRecord.findUnique({
      where: { observationId: obs61.observationId },
      select: { derivedMeasurementId: true },
    });
    expect(record61?.derivedMeasurementId).not.toBeNull();
    const measurement61 = await db.connectivityMeasurement.findUnique({
      where: { id: record61!.derivedMeasurementId! },
      select: { integrity: true, trust: true },
    });
    // The 61st is the first RATE_LIMITED — exceeds the limit.
    expect(measurement61?.integrity).toBe("RATE_LIMITED");
    expect(measurement61?.trust).toBe("UNTRUSTED");

    // Cleanup so the flood records don't affect other tests.
    await db.edgeObservationRecord.deleteMany({ where: { deviceId: dev } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({
      where: { resourceId: fx.resourceAId, source: "DEVICE", trust: "UNTRUSTED" },
    }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
  }, 90_000);
});
