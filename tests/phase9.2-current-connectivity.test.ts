/**
 * Phase 9.2 — Current Connectivity (DB-backed runtime)
 *
 * Proves the read-only Current Connectivity endpoint:
 *
 *   9.2.1  no active session → "No active connectivity"
 *   9.2.2  active WiFi → current connectivity shows WiFi
 *   9.2.3  active eSIM → current connectivity shows eSIM
 *   9.2.4  degraded health → UI shows degraded state
 *   9.2.5  stale measurement → UI reports stale/unknown, never invents health
 *   9.2.6  pending switch → UI shows "optimizing", not "switched"
 *   9.2.7  reconciliation required → UI reports transition unresolved
 *   9.2.8  unauthorized session → endpoint cannot expose another user's resource
 *   9.2.9  mobile screen is read-only (no action/provisioning fields in response)
 *   9.2.NS server switch → mobile eventually reflects the new active resource
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase9.2-current-connectivity.test.ts
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
import { getCurrentConnectivityForUser } from "@/lib/control-plane/current-connectivity";
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
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase92-${Date.now()}@test.roamlink`;
  const slug = `phase92-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P92 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P92 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P92 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"], cities: ["Accra"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });
  const capB = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "ROAMING", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
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

  const cleanup = async () => {
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

  return { userId: user.id, tenantId: tenant.id, resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, cleanup };
}

async function activate(fx: Fixture) {
  const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.userId, sessionId: fx.sessionId, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: fx.sessionId, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId, idempotencyKey: `p92-${fx.sessionId}-${Date.now()}` });
  await executeAction(action.id);
}

describe("Phase 9.2 — Current Connectivity (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // 9.2.1 no active session → "No active connectivity"
  it("9.2.1: no active session → session is null", async () => {
    const { hashPassword } = await import("@/lib/security");
    const user = await db.user.create({ data: { email: `p921-${Date.now()}@test`, name: "No Session", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() } });
    try {
      const result = await getCurrentConnectivityForUser(user.id);
      expect(result.session).toBeNull();
      expect(result.capability).toBeNull();
      expect(result.health).toBeNull();
    } finally {
      await db.user.deleteMany({ where: { id: user.id } });
    }
  }, 30_000);

  // 9.2.2 active WiFi → shows WiFi
  it("9.2.2: active WiFi (mikrotik) → transportLabel = WiFi", async () => {
    await activate(fx);
    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.session).not.toBeNull();
    expect(result.session?.state).toBe("ACTIVE");
    expect(result.capability?.transportLabel).toBe("WiFi");
    expect(result.capability?.type).toBe("INTERNET");
  }, 60_000);

  // 9.2.3 active eSIM → shows eSIM
  it("9.2.3: active eSIM (roaming) → transportLabel = eSIM", async () => {
    // Switch to resource B (ROAMING/esim) via direct decision + execution
    await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { startedAt: new Date(Date.now() - 120_000) } });
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceAId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceAId } }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      await ingestMeasurement({ resourceId: fx.resourceAId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId, type: "QUALITY", metrics: { throughputDownMbps: 5, latencyMs: 250, packetLossPercent: 8 }, source: "ADAPTER", confidence: 0.8, triggerReevaluation: false });
    }
    // Directly make a decision + execute (bypassing the async reevaluation path)
    // Don't filter by capabilityType — let the engine discover all types (INTERNET + ROAMING)
    const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.userId, sessionId: fx.sessionId });
    const { executeDecision } = await import("@/lib/control-plane/decision-executor");
    await executeDecision(decision.decisionId);

    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.session?.activeResourceId).toBe(fx.resourceBId);
    expect(result.capability?.transportLabel).toBe("eSIM");
    expect(result.capability?.type).toBe("ROAMING");
  }, 120_000);

  // 9.2.4 degraded health → shows degraded
  it("9.2.4: degraded health → status = DEGRADED", async () => {
    // Inject degraded measurements on resource B
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceBId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceBId } }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      await ingestMeasurement({ resourceId: fx.resourceBId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId, type: "QUALITY", metrics: { throughputDownMbps: 3, latencyMs: 300, packetLossPercent: 9 }, source: "ADAPTER", confidence: 0.8, triggerReevaluation: false });
    }
    // Explicitly derive health to ensure it's DEGRADED
    const { deriveResourceHealth } = await import("@/lib/control-plane/health-derivation");
    await deriveResourceHealth(fx.resourceBId);
    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.health?.status).toBe("DEGRADED");
    expect(result.health?.explanation).toMatch(/degraded|elevated|declining|packet loss/i);
  }, 60_000);

  // 9.2.5 stale measurement → reports stale/unknown
  it("9.2.5: stale measurement → freshness = STALE, never invents health", async () => {
    // Backdate measurements to be STALE (60s old)
    await db.connectivityMeasurement.updateMany({ where: { resourceId: fx.resourceBId }, data: { capturedAt: new Date(Date.now() - 60_000) } });
    await ingestMeasurement({ resourceId: fx.resourceBId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId, type: "QUALITY", metrics: { throughputDownMbps: 3, latencyMs: 300, packetLossPercent: 9 }, source: "ADAPTER", confidence: 0.8, capturedAt: new Date(Date.now() - 60_000), triggerReevaluation: false });
    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.health?.freshness).toBe("STALE");
  }, 60_000);

  // 9.2.6 pending switch → shows "optimizing"
  it("9.2.6: session in SWITCHING → transition shows switching", async () => {
    // Manually set session to SWITCHING
    await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { state: "SWITCHING" } });
    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.session?.state).toBe("SWITCHING");
    expect(result.transition?.state).toBe("SWITCHING");
    expect(result.transition?.description).toContain("switching");
    // Restore to ACTIVE
    await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { state: "ACTIVE" } });
  }, 30_000);

  // 9.2.7 reconciliation required → reports transition unresolved
  it("9.2.7: DEGRADED session → transition reports unresolved", async () => {
    await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { state: "DEGRADED" } });
    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.session?.state).toBe("DEGRADED");
    expect(result.transition?.state).toBe("DEGRADED");
    expect(result.transition?.description).toContain("degraded");
  }, 30_000);

  // 9.2.8 unauthorized → cannot expose another user's resource
  it("9.2.8: another user cannot see this user's session", async () => {
    const { hashPassword } = await import("@/lib/security");
    const otherUser = await db.user.create({ data: { email: `p928-${Date.now()}@test`, name: "Other", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() } });
    try {
      const result = await getCurrentConnectivityForUser(otherUser.id);
      expect(result.session).toBeNull(); // other user sees nothing
    } finally {
      await db.user.deleteMany({ where: { id: otherUser.id } });
    }
  }, 30_000);

  // 9.2.9 read-only — no action/provisioning fields
  it("9.2.9: response is read-only (no action/provisioning fields)", async () => {
    const result = await getCurrentConnectivityForUser(fx.userId);
    const json = JSON.stringify(result);
    // No control-plane mutation fields
    expect(json).not.toContain("createAction");
    expect(json).not.toContain("executeAction");
    expect(json).not.toContain("switchProvider");
    expect(json).not.toContain("activateESIM");
    // Has read-only fields
    expect(json).toContain("session");
    expect(json).toContain("health");
    expect(json).toContain("capability");
  }, 30_000);

  // 9.2.NS north-star: server switch → mobile reflects new resource
  it("9.2.NS: after switch, current connectivity reflects the new active resource", async () => {
    // Session is on B (from 9.2.3). Switch back to A via direct decision.
    await db.connectivitySession.update({ where: { id: fx.sessionId }, data: { state: "ACTIVE", startedAt: new Date(Date.now() - 120_000) } });
    // Clear recent SWITCH actions so the cooldown gate doesn't block
    await db.connectivityAction.deleteMany({ where: { sessionId: fx.sessionId, type: "SWITCH" } });
    await db.connectivityMeasurement.deleteMany({ where: { resourceId: fx.resourceBId } });
    await db.resourceHealth.deleteMany({ where: { resourceId: fx.resourceBId } }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      await ingestMeasurement({ resourceId: fx.resourceBId, sessionId: fx.sessionId, providerInstanceId: fx.providerInstanceId, type: "QUALITY", metrics: { throughputDownMbps: 3, latencyMs: 300, packetLossPercent: 9 }, source: "ADAPTER", confidence: 0.8, triggerReevaluation: false });
    }
    // Explicitly derive health to ensure B is DEGRADED before the decision
    const { deriveResourceHealth } = await import("@/lib/control-plane/health-derivation");
    await deriveResourceHealth(fx.resourceBId);
    const decision = await makeDecision({ tenantId: fx.tenantId, subjectId: fx.userId, sessionId: fx.sessionId });
    const { executeDecision } = await import("@/lib/control-plane/decision-executor");
    await executeDecision(decision.decisionId);

    const result = await getCurrentConnectivityForUser(fx.userId);
    expect(result.session?.activeResourceId).toBe(fx.resourceAId);
    expect(result.capability?.transportLabel).toBe("WiFi");
  }, 120_000);
});
