/**
 * Phase 10 — Observation Trust & Provenance (DB-backed)
 *
 * Tests:
 *   10.1: valid device observation → LIMITED trust, influences health
 *   10.2: future timestamp → UNTRUSTED, stored but excluded from health
 *   10.3: impossible metrics → UNTRUSTED, stored but excluded from health
 *   10.4: UNTRUSTED measurement cannot upgrade UNKNOWN → HEALTHY
 *   10.5: stale observation → UNTRUSTED, stored but excluded
 *   10.6: provider (ADAPTER) measurement → TRUSTED, influences health
 *   10.7: CurrentConnectivity exposes trust dimension
 *   10.8: suspicious observations remain persisted/auditable
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
import { ingestMeasurement } from "@/lib/control-plane/measurement-store";
import { deriveResourceHealth, getResourceHealth } from "@/lib/control-plane/health-derivation";
import { getCurrentConnectivityForUser } from "@/lib/control-plane/current-connectivity";
import { validateObservation } from "@/lib/control-plane/observation-validation";
import type { ObservationSource } from "@roamlink/shared";

type Fixture = {
  userId: string;
  tenantId: string;
  resourceAId: string;
  resourceBId: string;
  entitlementId: string;
  providerInstanceId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase10-${Date.now()}@test.roamlink`;
  const slug = `p10-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P10 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P10 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P10 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p10-${session.id}` });
  await executeAction(action.id);

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

  return { userId: user.id, tenantId: tenant.id, resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, cleanup };
}

describe("Phase 10 — Observation Trust & Provenance (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // 10.1: valid device observation → LIMITED trust, influences health
  it("10.1: valid device observation → LIMITED trust, influences health", async () => {
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});

    // Ingest a valid device observation (source=DEVICE, trust=LIMITED)
    await ingestMeasurement({
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      providerInstanceId: fx.providerInstanceId,
      type: "QUALITY",
      metrics: { throughputDownMbps: 50, latencyMs: 20, packetLossPercent: 0 },
      source: "DEVICE",
      confidence: 0.7,
      trust: "LIMITED",
      integrity: "VALID",
      triggerReevaluation: false,
    });

    const health = await getResourceHealth(fx.resourceAId);
    expect(health).not.toBeNull();
    expect(health?.status).toBe("HEALTHY");
    expect(health?.trust).toBe("LIMITED");
    expect(health?.sampleCount).toBeGreaterThan(0);
  }, 30_000);

  // 10.2: future timestamp → UNTRUSTED, stored but excluded from health
  it("10.2: future-timestamp observation → UNTRUSTED, excluded from health", async () => {
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceBId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceBId } }).catch(() => {});

    // Ingest a measurement with UNTRUSTED trust (simulating future timestamp)
    await ingestMeasurement({
      resourceId: fx.resourceBId,
      sessionId: fx.sessionId,
      providerInstanceId: fx.providerInstanceId,
      type: "QUALITY",
      metrics: { throughputDownMbps: 100, latencyMs: 5 },
      source: "DEVICE",
      confidence: 0.7,
      trust: "UNTRUSTED",
      integrity: "FUTURE_TIMESTAMP",
      triggerReevaluation: false,
    });

    // Derive health — UNTRUSTED should be excluded
    await deriveResourceHealth(fx.resourceBId);
    const health = await getResourceHealth(fx.resourceBId);
    expect(health).not.toBeNull();
    // No eligible measurements → UNKNOWN
    expect(health?.status).toBe("UNKNOWN");
    expect(health?.trust).toBe("UNTRUSTED");
    expect(health?.sampleCount).toBe(0);

    // But the measurement IS persisted (auditable)
    const count = await db.connectivityMeasurement.count({
      where: { resourceId: fx.resourceBId, trust: "UNTRUSTED" },
    });
    expect(count).toBeGreaterThan(0);
  }, 30_000);

  // 10.3: impossible metrics → UNTRUSTED via validation
  it("10.3: impossible metrics (throughput=999999) → UNTRUSTED via validateObservation", async () => {
    const result = await validateObservation({
      deviceId: "test-device",
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      userId: fx.userId,
      observedAt: new Date(),
      source: "DEVICE" as ObservationSource,
      metrics: { throughputDownMbps: 999999, latencyMs: 20 },
    });
    expect(result.integrity).toBe("INVALID_METRIC");
    expect(result.trust).toBe("UNTRUSTED");
  }, 15_000);

  // 10.4: UNTRUSTED cannot upgrade UNKNOWN → HEALTHY
  it("10.4: UNTRUSTED measurements cannot upgrade health to HEALTHY", async () => {
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceBId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceBId } }).catch(() => {});

    // Ingest 3 UNTRUSTED "healthy" measurements
    for (let i = 0; i < 3; i++) {
      await ingestMeasurement({
        resourceId: fx.resourceBId,
        sessionId: fx.sessionId,
        providerInstanceId: fx.providerInstanceId,
        type: "QUALITY",
        metrics: { throughputDownMbps: 100, latencyMs: 10, packetLossPercent: 0 },
        source: "DEVICE",
        confidence: 0.7,
        trust: "UNTRUSTED",
        integrity: "INVALID_METRIC",
        triggerReevaluation: false,
      });
    }

    await deriveResourceHealth(fx.resourceBId);
    const health = await getResourceHealth(fx.resourceBId);
    // Should remain UNKNOWN — UNTRUSTED cannot upgrade
    expect(health?.status).toBe("UNKNOWN");
    expect(health?.trust).toBe("UNTRUSTED");
    expect(health?.sampleCount).toBe(0);

    // But the 3 measurements are persisted (auditable)
    const count = await db.connectivityMeasurement.count({
      where: { resourceId: fx.resourceBId, trust: "UNTRUSTED" },
    });
    expect(count).toBeGreaterThanOrEqual(3);
  }, 30_000);

  // 10.5: stale observation → UNTRUSTED via validation
  it("10.5: stale observation (old capturedAt) → STALE integrity, UNTRUSTED", async () => {
    const result = await validateObservation({
      deviceId: "test-device",
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      userId: fx.userId,
      observedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago — stale
      source: "DEVICE" as ObservationSource,
      metrics: { throughputDownMbps: 50, latencyMs: 20 },
    });
    expect(result.integrity).toBe("STALE");
    expect(result.trust).toBe("UNTRUSTED");
  }, 15_000);

  // 10.6: provider (ADAPTER) measurement → TRUSTED, influences health
  it("10.6: adapter measurement → TRUSTED, influences health", async () => {
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId, source: "ADAPTER" } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});

    await ingestMeasurement({
      resourceId: fx.resourceAId,
      sessionId: fx.sessionId,
      providerInstanceId: fx.providerInstanceId,
      type: "QUALITY",
      metrics: { throughputDownMbps: 80, latencyMs: 15, packetLossPercent: 0 },
      source: "ADAPTER",
      confidence: 0.8,
      trust: "TRUSTED",
      integrity: "VALID",
      triggerReevaluation: false,
    });

    const health = await getResourceHealth(fx.resourceAId);
    expect(health?.status).toBe("HEALTHY");
    expect(health?.trust).toBe("TRUSTED");
  }, 30_000);

  // 10.7: CurrentConnectivity exposes trust
  it("10.7: CurrentConnectivity exposes trust dimension", async () => {
    const current = await getCurrentConnectivityForUser(fx.userId);
    expect(current.health).not.toBeNull();
    expect(current.health?.trust).toBeDefined();
    expect(["TRUSTED", "LIMITED", "UNTRUSTED"]).toContain(current.health?.trust);
  }, 30_000);

  // 10.8: suspicious observations remain persisted/auditable
  it("10.8: suspicious observations remain persisted and auditable", async () => {
    const untrustedCount = await db.connectivityMeasurement.count({
      where: { trust: "UNTRUSTED" },
    });
    expect(untrustedCount).toBeGreaterThan(0);

    // Verify they have integrity classifications
    const untrusted = await db.connectivityMeasurement.findFirst({
      where: { trust: "UNTRUSTED" },
      select: { integrity: true, trust: true, metrics: true },
    });
    expect(untrusted?.trust).toBe("UNTRUSTED");
    expect(untrusted?.integrity).not.toBe("VALID");
  }, 15_000);
});
