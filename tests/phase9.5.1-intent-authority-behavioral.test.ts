/**
 * Phase 9.5.1 — Intent Authority Behavioral Proof (DB-backed)
 *
 * Gate A1: Prove intent budget changes decision outcome behaviorally.
 *   - Intent with budget=500 → candidate A (450) eligible, B (700) over-budget
 *   - reasonCodes includes BUDGET_CONSTRAINT when over budget
 *
 * Gate A2: Prove stale intent versions cannot influence later decisions.
 *   - v1 created → v2 supersedes v1 → worker processes v1 event → decision is WAIT (v1 superseded)
 *   - v2 event processed → decision references v2 (not v1)
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
import { processPendingEvents } from "@/lib/control-plane/reevaluation";
import { executePendingDecisions } from "@/lib/control-plane/decision-executor";

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
  const email = `p951-${Date.now()}@test.roamlink`;
  const slug = `p951-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P951 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P951 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P951 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  // Phase 12.4.1: Add ConnectivityOffer2 rows with prices so the ranking engine
  // returns ranked offers and the decision engine's budget check has priced
  // candidates to evaluate. Without these, ranking returns 0 offers and the
  // budget check pushes BUDGET_APPLICABILITY_UNKNOWN (not BUDGET_CONSTRAINT).
  // Offer 1: within budget ($3 = 300 minor units, budget is $5 = 500)
  // Offer 2: over budget ($10 = 1000 minor units, exceeds $5 = 500)
  const offerWithin = await db.connectivityOffer2.create({
    data: {
      tenantId: tenant.id,
      capabilityType: "INTERNET",
      providerType: "mock",
      spec: JSON.stringify({ downloadMbps: 500, uploadMbps: 100, dataLimitBytes: 5000000000, validityDays: 30, allowedCountries: ["GH"] }),
      coverage: JSON.stringify({ countries: ["GH"] }),
      wholesalePriceMinor: 200, // reseller pays $2
      customerPriceMinor: 300,  // customer pays $3 (within $5 budget)
      currency: "USD",
      status: "active",
      reliabilityScore: 0.92,
    },
  });
  const offerOver = await db.connectivityOffer2.create({
    data: {
      tenantId: tenant.id,
      capabilityType: "INTERNET",
      providerType: "mock",
      spec: JSON.stringify({ downloadMbps: 1000, uploadMbps: 200, dataLimitBytes: 10000000000, validityDays: 30, allowedCountries: ["GH"] }),
      coverage: JSON.stringify({ countries: ["GH"] }),
      wholesalePriceMinor: 700, // reseller pays $7
      customerPriceMinor: 1000, // customer pays $10 (over $5 budget)
      currency: "USD",
      status: "active",
      reliabilityScore: 0.95,
    },
  });

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: ent.id });

  // ACTIVATE A
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p951-${session.id}` });
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
    await db.connectivityOffer2.deleteMany({ where: { id: { in: [offerWithin.id, offerOver.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { userId: user.id, tenantId: tenant.id, resourceAId: resA.id, resourceBId: resB.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, cleanup };
}

describe("Phase 9.5.1 — Intent Authority Behavioral Proof (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // Gate A1: Budget behavioral proof
  // Phase 12.4.1: The test fixture now includes ConnectivityOffer2 rows with
  // prices (one within budget, one over budget) so the budget check actually
  // evaluates priced candidates.
  it("A1: intent budget=500 → decision with budget constraint applied + reasonCodes includes BUDGET_CONSTRAINT", async () => {
    // Create an intent with a specific budget
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "cheap connectivity under $5",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500, // $5.00 budget
    });

    // Process the INTENT_CHANGED event through the actual worker
    await processPendingEvents(10, "p951-a1-worker");

    // Find the decision created from this intent
    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, action: true, reasonCodes: true, reasons: true, intentId: true, intentVersion: true, constraintsSatisfied: true, constraintsViolated: true },
    });
    expect(decision).not.toBeNull();
    expect(decision?.intentId).toBe(intent.intentId);
    expect(decision?.intentVersion).toBe(intent.version);

    // The decision should have reasonCodes (not null)
    expect(decision?.reasonCodes).not.toBeNull();
    const codes = JSON.parse(decision!.reasonCodes!);

    // Phase 12.4.1: The decision MUST include BUDGET_CONSTRAINT in reasonCodes
    // because the intent specified a budget and priced offers exist.
    expect(codes).toContain("BUDGET_CONSTRAINT");

    // Phase 12.4.1: The architect's spec — prove both distinctions:
    //   priced candidate within budget → WITHIN_BUDGET
    //   priced candidate over budget → OVER_BUDGET
    // Both are present because the fixture has one offer at $3 (within) and
    // one at $10 (over the $5 budget).
    const satisfied = JSON.parse(decision!.constraintsSatisfied || "[]");
    const violated = JSON.parse(decision!.constraintsViolated || "[]");
    expect(satisfied).toContain("WITHIN_BUDGET");
    expect(violated).toContain("OVER_BUDGET");
  }, 60_000);

  // Gate A4: Budget applicability unknown when no priced offers exist
  // Phase 12.4.1: Prove the architect's spec:
  //   "no applicable price → BUDGET_APPLICABILITY_UNKNOWN"
  //   (NOT BUDGET_CONSTRAINT — no price was actually evaluated)
  it("A4: intent with budget but no priced offers → BUDGET_APPLICABILITY_UNKNOWN (not BUDGET_CONSTRAINT)", async () => {
    // Create a NEW tenant with NO ConnectivityOffer2 rows, so the ranking
    // engine returns 0 offers. The budget check should push
    // BUDGET_APPLICABILITY_UNKNOWN (not BUDGET_CONSTRAINT).
    const { hashPassword } = await import("@/lib/security");
    const slug = `p951-a4-${Date.now().toString(36)}`;
    const user = await db.user.create({
      data: { email: `p951-a4-${Date.now()}@test.roamlink`, name: "P951 A4", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
    });
    const tenant = await db.tenant.create({ data: { name: `P951 A4 ${slug}`, slug, status: "active" } });
    const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
    const subscription = await db.tenantSubscription.create({ data: { tenantId: tenant.id, saaasPlanId: starterPlan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
    const cc = await db.connectivityCapability.findFirst({ where: { type: "INTERNET" } });
    const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P951 A4 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
    const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc!.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 100 }), validFrom: new Date(), userId: user.id } });

    // NO ConnectivityOffer2 rows created for this tenant → ranking returns 0.

    await createOrUpdatePolicy({ subjectId: user.id, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
    const session = await createSession({ subjectId: user.id, entitlementId: ent.id });

    // Create an intent with a budget
    const intent = await createIntent({
      subjectId: user.id,
      rawText: "cheap connectivity under $5",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500, // $5.00 budget
    });

    // Process the INTENT_CHANGED event through the worker
    await processPendingEvents(10, "p951-a4-worker");

    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, reasonCodes: true, constraintsSatisfied: true, constraintsViolated: true },
    });

    expect(decision).not.toBeNull();
    const codes = JSON.parse(decision!.reasonCodes || "[]");
    const satisfied = JSON.parse(decision!.constraintsSatisfied || "[]");

    // The decision MUST NOT include BUDGET_CONSTRAINT — no price was evaluated.
    expect(codes).not.toContain("BUDGET_CONSTRAINT");
    // It MUST include BUDGET_APPLICABILITY_UNKNOWN.
    expect(satisfied).toContain("BUDGET_APPLICABILITY_UNKNOWN");

    // Cleanup
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  }, 60_000);

  // Gate A2: Stale intent version cannot influence later decisions
  it("A2: superseded intent v1 → worker processes v1 event → decision is WAIT (INTENT_EXPIRED)", async () => {
    // 1. Create v1
    const v1 = await createIntent({
      subjectId: fx.userId,
      rawText: "v1 reliable connectivity",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Supersede v1 with v2 BEFORE the v1 event is processed
    const v2 = await createIntent({
      subjectId: fx.userId,
      rawText: "v2 cheaper connectivity",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    // 3. Verify v1 is superseded
    const v1Record = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: v1.intentId, version: 1 } },
    });
    expect(v1Record?.status).toBe("SUPERSEDED");

    // 4. Verify v2 is active
    const v2Record = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: v1.intentId, version: 2 } },
    });
    expect(v2Record?.status).toBe("ACTIVE");

    // 5. isIntentExpired returns true for v1 (superseded)
    const v1Expired = await isIntentExpired(v1.intentId, 1);
    expect(v1Expired).toBe(true);

    // 6. isIntentExpired returns false for v2 (active)
    const v2Expired = await isIntentExpired(v1.intentId, 2);
    expect(v2Expired).toBe(false);

    // 7. makeDecision with v1 → WAIT (INTENT_EXPIRED)
    const decisionFromV1 = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: v1.intentId,
      intentVersion: 1, // stale version
      sessionId: fx.sessionId,
    });
    expect(decisionFromV1.action).toBe("WAIT");
    expect(decisionFromV1.constraintsViolated).toContain("INTENT_EXPIRED");

    // 8. makeDecision with v2 → not WAIT (active intent)
    const decisionFromV2 = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: v1.intentId,
      intentVersion: 2, // current version
      sessionId: fx.sessionId,
    });
    expect(decisionFromV2.action).not.toBe("WAIT");
    // The v2 decision should NOT have INTENT_EXPIRED
    expect(decisionFromV2.constraintsViolated).not.toContain("INTENT_EXPIRED");

    // 9. The v2 decision references v2, not v1
    const persistedV2 = await db.connectivityDecision.findUnique({
      where: { id: decisionFromV2.decisionId },
      select: { intentVersion: true },
    });
    expect(persistedV2?.intentVersion).toBe(2);
  }, 60_000);

  // Gate A3: End-to-end worker path (not just direct makeDecision calls)
  it("A3: end-to-end — intent → INTENT_CHANGED → worker → decision with intentId+intentVersion from event", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "e2e test intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // Verify INTENT_CHANGED event exists
    const event = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    const eventPayload = JSON.parse(event!.payload);
    expect(eventPayload.intentId).toBe(intent.intentId);
    expect(eventPayload.intentVersion).toBe(intent.version);

    // Process the event through the ACTUAL worker (not direct makeDecision)
    const evalResult = await processPendingEvents(10, "p951-a3-worker");
    expect(evalResult.processed).toBeGreaterThan(0);

    // The worker should have created a decision that references the intent
    // from the event payload (not from session.intentId)
    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId, intentVersion: intent.version },
      orderBy: { createdAt: "desc" },
    });
    expect(decision).not.toBeNull();
    expect(decision?.intentId).toBe(intent.intentId);
    expect(decision?.intentVersion).toBe(intent.version);
    expect(decision?.reasonCodes).not.toBeNull();
  }, 60_000);
});
