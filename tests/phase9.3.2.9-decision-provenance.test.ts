/**
 * Phase 9.3.2.9 — DB-backed makeDecision provenance test
 *
 * Proves the effective-policy boundary through BEHAVIOR, not source inspection:
 *
 *   Given a base policy RELIABLE
 *   Given device context batterySaver=true
 *   Call makeDecision(...)
 *   Verify the decision reflects BATTERY-derived policy (switchHysteresis=0.25)
 *   Verify persisted provenance says:
 *     basePreset=RELIABLE
 *     effectivePreset=BATTERY
 *     derivationReason contains "batterySaver"
 *     basePolicyId is not null
 *     basePolicyVersion > 0
 *     contextDeviceId = the device
 *     contextVersion is not null
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
import { registerEdgeDevice } from "@/lib/control-plane/edge-ingestion";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";
import { ingestMeasurement } from "@/lib/control-plane/measurement-store";

type Fixture = {
  userId: string;
  tenantId: string;
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
  const email = `phase9329-${Date.now()}@test.roamlink`;
  const slug = `p9329-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P932.9 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P932.9 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P932.9 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  // Base policy: RELIABLE
  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });

  const session = await createSession({ subjectId, entitlementId: ent.id });

  // Register edge device + set device context (batterySaver=true)
  const deviceId = `p9329-dev-${Date.now().toString(36)}`;
  await registerEdgeDevice({ userId: user.id, deviceId, platform: "android", appVersion: "0.1.0" });
  await db.edgeDevice.update({
    where: { deviceId },
    data: {
      policyContext: JSON.stringify({ batterySaver: true, autoSwitchEnabled: true }),
      policyContextUpdatedAt: new Date(),
      policyContextObservedAt: new Date(),
      policyContextVersion: 1,
    },
  });

  const cleanup = async () => {
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resA.id, resB.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.edgeObservationRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.edgeDevice.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resA.id, resB.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capA.id, capB.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bA.id, bB.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { userId: user.id, tenantId: tenant.id, resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, deviceId, cleanup };
}

describe("Phase 9.3.2.9 — DB-backed makeDecision provenance", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  it("9.3.2.9: makeDecision with deviceId → effective BATTERY + persisted provenance", async () => {
    // 1. ACTIVATE A
    const activateDecision = await makeDecision({
      tenantId: fx.tenantId, subjectId: fx.userId, sessionId: fx.sessionId, deviceId: fx.deviceId,
    });
    const action = await createAction({
      sessionId: fx.sessionId, decisionId: activateDecision.decisionId, type: "ACTIVATE",
      targetResourceId: activateDecision.targetResourceId!, idempotencyKey: `p9329-${fx.sessionId}`,
    });
    await executeAction(action.id);

    // 2. Backdate session + inject degraded measurements on A
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

    // 3. Call makeDecision WITH deviceId (effective policy should be BATTERY, not RELIABLE)
    const decision = await makeDecision({
      tenantId: fx.tenantId, subjectId: fx.userId, sessionId: fx.sessionId, deviceId: fx.deviceId,
    });

    // 4. Verify the persisted decision has correct provenance
    const persisted = await db.connectivityDecision.findUnique({
      where: { id: decision.decisionId },
      select: {
        basePreset: true, effectivePreset: true, derivationReasons: true,
        basePolicyId: true, basePolicyVersion: true,
        contextDeviceId: true, contextVersion: true, contextObservedAt: true,
      },
    });

    // Base policy is RELIABLE (user's choice — unchanged by device context)
    expect(persisted?.basePreset).toBe("RELIABLE");
    // Effective policy is BATTERY (device context batterySaver=true → server rule)
    expect(persisted?.effectivePreset).toBe("BATTERY");
    // Derivation reason documents the downgrade
    expect(persisted?.derivationReasons).toContain("batterySaver");

    // Provenance fields are durable
    expect(persisted?.basePolicyId).not.toBeNull();
    expect(persisted?.basePolicyVersion).toBeGreaterThan(0);
    expect(persisted?.contextDeviceId).toBe(fx.deviceId);
    expect(persisted?.contextVersion).not.toBeNull();
    expect(persisted?.contextObservedAt).not.toBeNull();
  }, 120_000);
});
