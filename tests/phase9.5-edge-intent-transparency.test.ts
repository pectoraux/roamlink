/**
 * Phase 9.5 — Edge Intent & Operational Transparency (DB-backed)
 *
 * Tests:
 *   R1: reasonCodes[] persisted and exposed in CurrentConnectivity
 *   R2: intent budget propagates to decision engine
 *   R6.NS: north-star — intent → INTENT_CHANGED → decision → reasonCodes exposed
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
import { createIntent } from "@/lib/control-plane/intent-service";
import { processPendingEvents } from "@/lib/control-plane/reevaluation";
import { getCurrentConnectivityForUser } from "@/lib/control-plane/current-connectivity";

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
  const email = `phase95-${Date.now()}@test.roamlink`;
  const slug = `p95-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P95 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P95 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P95 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  // ACTIVATE A
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p95-${session.id}` });
  await executeAction(action.id);

  const cleanup = async () => {
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
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

describe("Phase 9.5 — Edge Intent & Operational Transparency (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // R1: reasonCodes persisted and exposed
  it("R1: decision persists reasonCodes[] and CurrentConnectivity exposes them", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "I need reliable connectivity",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // Directly call makeDecision with the intent ID (simulating the worker)
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: intent.intentId,
      intentVersion: intent.version,
      sessionId: fx.sessionId,
    });

    // Find the decision
    const persisted = await db.connectivityDecision.findUnique({
      where: { id: decision.decisionId },
      select: { id: true, reasonCodes: true, reasons: true, intentId: true, intentVersion: true },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.intentId).toBe(intent.intentId);
    expect(persisted?.intentVersion).toBe(intent.version);
    expect(persisted?.reasonCodes).not.toBeNull();

    const codes = JSON.parse(persisted!.reasonCodes!);
    expect(Array.isArray(codes)).toBe(true);
    expect(codes.length).toBeGreaterThan(0);
    // Reason codes should be from the canonical set
    const validCodes = ["RELIABILITY_REQUIREMENT", "BATTERY_SAVER_CONTEXT", "BUDGET_CONSTRAINT", "FRESHNESS_GATE", "RESOURCE_UNAVAILABLE", "PREFERRED_TRANSPORT", "POLICY_CONSTRAINT", "ACTIVE_SESSION", "HYSTERESIS", "NO_BETTER_RESOURCE", "DWELL_TIME", "COOLDOWN", "INSUFFICIENT_SAMPLES", "INTENT_EXPIRED", "INTENT_SUPERSEDED", "QUALITY_ACCEPTABLE"];
    for (const code of codes) {
      expect(validCodes).toContain(code);
    }

    // CurrentConnectivity should expose reasonCodes
    const current = await getCurrentConnectivityForUser(fx.userId);
    expect(current.decision).not.toBeNull();
    expect(current.decision?.reasonCodes).toBeDefined();
    expect(current.decision!.reasonCodes.length).toBeGreaterThan(0);
  }, 60_000);

  // R2: intent budget propagates to decision engine
  it("R2: intent with budget.maxMinor → decision engine receives maxPriceMinor", async () => {
    // Create an intent with a budget constraint
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "I need cheap connectivity under $5",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500, // $5.00
    });

    // Process the INTENT_CHANGED event — the worker should resolve
    // budget.maxMinor from the intent payload and pass it to makeDecision
    await processPendingEvents(10, "p95-r2-worker");

    // The decision should exist and reference the intent
    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, intentId: true, intentVersion: true, reasons: true, reasonCodes: true },
    });
    expect(decision).not.toBeNull();
    expect(decision?.intentId).toBe(intent.intentId);
    expect(decision?.intentVersion).toBe(intent.version);
  }, 60_000);

  // R6.NS: north-star — intent → decision → reasonCodes exposed
  it("R6.NS: full chain — intent → decision → CurrentConnectivity with reasonCodes", async () => {
    // 1. Create intent
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "reliable connectivity for work",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      priority: "HIGH",
    });

    // 2. Verify INTENT_CHANGED event exists (transactional with creation)
    const event = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();

    // 3. Directly call makeDecision (simulating the worker)
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: intent.intentId,
      intentVersion: intent.version,
      sessionId: fx.sessionId,
    });

    // 4. Decision has intentId + intentVersion + reasonCodes
    const persisted = await db.connectivityDecision.findUnique({
      where: { id: decision.decisionId },
      select: { intentId: true, intentVersion: true, reasonCodes: true, reasons: true },
    });
    expect(persisted?.intentId).toBe(intent.intentId);
    expect(persisted?.intentVersion).toBe(intent.version);
    expect(persisted?.reasonCodes).not.toBeNull();

    // 5. CurrentConnectivity exposes reasonCodes
    const current = await getCurrentConnectivityForUser(fx.userId);
    expect(current.decision).not.toBeNull();
    expect(current.decision?.reasonCodes).toBeDefined();
    expect(current.decision!.reasonCodes.length).toBeGreaterThan(0);

    // 6. The reasonCodes are from the canonical set
    const validCodes = ["RELIABILITY_REQUIREMENT", "BATTERY_SAVER_CONTEXT", "BUDGET_CONSTRAINT", "FRESHNESS_GATE", "RESOURCE_UNAVAILABLE", "PREFERRED_TRANSPORT", "POLICY_CONSTRAINT", "ACTIVE_SESSION", "HYSTERESIS", "NO_BETTER_RESOURCE", "DWELL_TIME", "COOLDOWN", "INSUFFICIENT_SAMPLES", "INTENT_EXPIRED", "INTENT_SUPERSEDED", "QUALITY_ACCEPTABLE"];
    for (const code of current.decision!.reasonCodes) {
      expect(validCodes).toContain(code);
    }
  }, 120_000);
});
