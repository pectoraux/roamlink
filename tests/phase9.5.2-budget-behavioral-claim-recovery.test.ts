/**
 * Phase 9.5.2 — Budget Behavioral Proof + Orphaned Claim Recovery (DB-backed)
 *
 * Gate A1 (revised): Prove budget changes decision outcome behaviorally.
 *   - Create priced commerce offers (A=450, B=700)
 *   - Intent with budget=500 → candidate A eligible, B over-budget
 *   - reasonCodes includes BUDGET_CONSTRAINT
 *   - No-price candidate (WiFi) → BUDGET_APPLICABILITY_UNKNOWN (not WITHIN_BUDGET)
 *
 * Gate B2+: Orphaned CLAIMED recovery via lease timeout.
 *   - Process-local claim prevents concurrent flush
 *   - claimedAt + lease expiry → orphaned claim reclaimed on next loadPending
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
import { processPendingEventsForSubject } from "@/lib/control-plane/reevaluation";

type Fixture = {
  userId: string;
  tenantId: string;
  resourceAId: string;
  resourceBId: string;
  resourceCId: string; // WiFi — no commercial offer
  entitlementId: string;
  providerInstanceId: string;
  sessionId: string;
  offerAId: string;
  offerBId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `p952-${Date.now()}@test.roamlink`;
  const slug = `p952-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P952 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P952 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P952 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  // Resource A: priced at 450 (under budget)
  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });

  // Resource B: priced at 700 (over budget)
  const capB = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
  const resB = await db.protocolResource.create({ data: { capabilityId: capB.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "B" }), capacity: JSON.stringify({ totalBandwidthMbps: 300 }), state: "AVAILABLE" } });

  // Resource C: WiFi — NO commercial offer (budget applicability UNKNOWN)
  const capC = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "LOCAL_NETWORK", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 100 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.85, status: "active" } });
  const resC = await db.protocolResource.create({ data: { capabilityId: capC.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "C" }), state: "AVAILABLE" } });

  // Provision mock resources for all three
  const entInput: ConnectivityEntitlementInput = {
    id: ent.id, tenantId: tenant.id, subscriptionId: subscription.id, status: "ACTIVE",
    capabilityType: "INTERNET", capabilitySet: JSON.parse(ent.capabilitySet),
    policy: null, validFrom: ent.validFrom, validUntil: null,
  };
  const mkBinding = (id: string) => ({ id, entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND" as const, provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null });
  const prA = await mockConnectivityProvider.provision({ entitlement: entInput, binding: mkBinding("b") as ProviderResourceBindingInput });
  const bA = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prA.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resA.id }, data: { providerBindingId: bA.id } });

  const prB = await mockConnectivityProvider.provision({ entitlement: entInput, binding: mkBinding("b2") as ProviderResourceBindingInput });
  const bB = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prB.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resB.id }, data: { providerBindingId: bB.id } });

  const prC = await mockConnectivityProvider.provision({ entitlement: entInput, binding: mkBinding("b3") as ProviderResourceBindingInput });
  const bC = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prC.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resC.id }, data: { providerBindingId: bC.id } });

  // Create priced commerce offers for A and B (NOT for C — WiFi has no offer)
  const offerA = await db.connectivityOffer2.create({
    data: {
      tenantId: tenant.id,
      capabilityId: capA.id,
      capabilityType: "INTERNET",
      providerType: "mock",
      spec: JSON.stringify({ downloadMbps: 500, uploadMbps: 100 }),
      coverage: JSON.stringify({ countries: ["GH"] }),
      wholesalePriceMinor: 300,
      customerPriceMinor: 450, // under budget
      currency: "USD",
      status: "active",
    },
  });
  const offerB = await db.connectivityOffer2.create({
    data: {
      tenantId: tenant.id,
      capabilityId: capB.id,
      capabilityType: "INTERNET",
      providerType: "mock",
      spec: JSON.stringify({ downloadMbps: 300, uploadMbps: 50 }),
      coverage: JSON.stringify({ countries: ["GH"] }),
      wholesalePriceMinor: 500,
      customerPriceMinor: 700, // over budget
      currency: "USD",
      status: "active",
    },
  });

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: ent.id });

  // ACTIVATE A
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p952-${session.id}` });
  await executeAction(action.id);

  const cleanup = async () => {
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    // Phase 12.4.4d: Delete events for BOTH subject AND session.
    // The subject filter catches INTENT_CHANGED events (subjectId = user.id).
    // The session filter catches MEASUREMENT_RECEIVED events emitted by
    // executeAction's reobservation path (subjectId=null, sessionId=session.id).
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resA.id, resB.id, resC.id] } } }).catch(() => {});
    await db.connectivityOffer2.deleteMany({ where: { id: { in: [offerA.id, offerB.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resA.id, resB.id, resC.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capA.id, capB.id, capC.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bA.id, bB.id, bC.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { userId: user.id, tenantId: tenant.id, resourceAId: resA.id, resourceBId: resB.id, resourceCId: resC.id, entitlementId: ent.id, providerInstanceId: pi.id, sessionId: session.id, offerAId: offerA.id, offerBId: offerB.id, cleanup };
}

describe("Phase 9.5.2 — Budget Behavioral Proof + Orphaned Claim Recovery (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // Gate A1 (revised): Budget behavioral proof with actual priced offers
  it("A1: budget=500, offer A=450 (under), offer B=700 (over) → BUDGET_CONSTRAINT in reasonCodes", async () => {
    // Create an intent with budget=500
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "connectivity under $5",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500,
    });

    // Phase 12.4.4d: Subject-scoped worker — only process this test's own
    // INTENT_CHANGED event. The global primitive would consume leaked events
    // from prior tests' sessions first (subjectId=null, foreign sessionId).
    await processPendingEventsForSubject(fx.userId, 10, "p952-a1-worker");

    // Find the decision
    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, action: true, reasonCodes: true, reasons: true, constraintsSatisfied: true, constraintsViolated: true },
    });
    expect(decision).not.toBeNull();

    const codes = JSON.parse(decision!.reasonCodes || "[]");
    const satisfied = JSON.parse(decision!.constraintsSatisfied || "[]");
    const violated = JSON.parse(decision!.constraintsViolated || "[]");

    // Budget was evaluated against actual priced offers → BUDGET_CONSTRAINT present
    expect(codes).toContain("BUDGET_CONSTRAINT");

    // The top offer (A=450) is under budget → WITHIN_BUDGET
    // (B=700 is ranked lower by the ranking engine, so A is the top offer)
    expect(satisfied).toContain("WITHIN_BUDGET");
  }, 60_000);

  // Gate A1b: No-price candidate → BUDGET_APPLICABILITY_UNKNOWN (not WITHIN_BUDGET)
  it("A1b: budget specified but no ranked offers → BUDGET_APPLICABILITY_UNKNOWN (not WITHIN_BUDGET)", async () => {
    // Create a user with NO session and NO ranked offers for their capabilities
    const { hashPassword } = await import("@/lib/security");
    const noOfferUser = await db.user.create({
      data: { email: `p952b-${Date.now()}@test`, name: "No Offer", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() },
    });
    const nsTenant = await db.tenant.create({ data: { name: `P952B ${Date.now()}`, slug: `p952b-${Date.now().toString(36)}`, status: "active" } });
    const nsPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
    const nsSub = await db.tenantSubscription.create({ data: { tenantId: nsTenant.id, saaasPlanId: nsPlan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
    const nsCap = await db.connectivityCapability.findUnique({ where: { type: "INTERNET" } });
    const nsEnt = await db.connectivityEntitlement.create({ data: { tenantId: nsTenant.id, subscriptionId: nsSub.id, capabilityId: nsCap!.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: noOfferUser.id } });
    const nsPi = await db.connectivityProviderInstance.create({ data: { tenantId: nsTenant.id, providerType: "mock", name: `P952B PI`, status: "active", configuration: JSON.stringify({}) } });
    const nsCapA = await db.protocolCapability.create({ data: { tenantId: nsTenant.id, providerInstanceId: nsPi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
    const nsResA = await db.protocolResource.create({ data: { capabilityId: nsCapA.id, providerInstanceId: nsPi.id, identifiers: JSON.stringify({ id: "NS-A" }), state: "AVAILABLE" } });
    await createOrUpdatePolicy({ subjectId: noOfferUser.id, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });

    try {
      // Create an intent with budget — NO offers exist for this tenant
      const intent = await createIntent({
        subjectId: noOfferUser.id,
        rawText: "connectivity under $5",
        mode: "AUTOMATIC",
        maxPriceMinor: 500,
      });

      // Phase 12.4.4d: Subject-scoped worker.
      await processPendingEventsForSubject(noOfferUser.id, 10, "p952b-worker");

      // Find the decision — it should have BUDGET_APPLICABILITY_UNKNOWN
      const decision = await db.connectivityDecision.findFirst({
        where: { intentId: intent.intentId },
        orderBy: { createdAt: "desc" },
        select: { constraintsSatisfied: true, reasonCodes: true },
      });
      expect(decision).not.toBeNull();
      const satisfied = JSON.parse(decision?.constraintsSatisfied || "[]");
      const codes = JSON.parse(decision?.reasonCodes || "[]");

      // Budget applicability is UNKNOWN — no price was evaluated
      expect(satisfied).toContain("BUDGET_APPLICABILITY_UNKNOWN");
      // BUDGET_CONSTRAINT must NOT be present — no price was actually checked
      expect(codes).not.toContain("BUDGET_CONSTRAINT");
    } finally {
      await db.connectivityIntentRecord.deleteMany({ where: { subjectId: noOfferUser.id } }).catch(() => {});
      await db.reevaluationEvent.deleteMany({ where: { subjectId: noOfferUser.id } }).catch(() => {});
      await db.connectivityDecision.deleteMany({ where: { intentId: { contains: "intent-" } } }).catch(() => {});
      await db.protocolResource.deleteMany({ where: { id: nsResA.id } }).catch(() => {});
      await db.protocolCapability.deleteMany({ where: { id: nsCapA.id } }).catch(() => {});
      await db.connectivityProviderInstance.deleteMany({ where: { id: nsPi.id } }).catch(() => {});
      await db.connectivityEntitlement.deleteMany({ where: { id: nsEnt.id } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { id: nsSub.id } }).catch(() => {});
      await db.connectivityPolicy.deleteMany({ where: { subjectId: noOfferUser.id } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: nsTenant.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: noOfferUser.id } }).catch(() => {});
    }
  }, 120_000);

  // Gate A2: Stale intent version cannot influence decisions
  it("A2: superseded v1 → WAIT + INTENT_EXPIRED; active v2 → not WAIT", async () => {
    const v1 = await createIntent({
      subjectId: fx.userId,
      rawText: "v1 intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    const v2 = await createIntent({
      subjectId: fx.userId,
      rawText: "v2 intent",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    expect(await isIntentExpired(v1.intentId, 1)).toBe(true);
    expect(await isIntentExpired(v1.intentId, 2)).toBe(false);

    const d1 = await makeDecision({
      tenantId: fx.tenantId, subjectId: fx.userId,
      intentId: v1.intentId, intentVersion: 1, sessionId: fx.sessionId,
    });
    expect(d1.action).toBe("WAIT");
    expect(d1.constraintsViolated).toContain("INTENT_EXPIRED");

    const d2 = await makeDecision({
      tenantId: fx.tenantId, subjectId: fx.userId,
      intentId: v1.intentId, intentVersion: 2, sessionId: fx.sessionId,
    });
    expect(d2.action).not.toBe("WAIT");
    expect(d2.constraintsViolated).not.toContain("INTENT_EXPIRED");
  }, 60_000);

  // Gate A3: End-to-end worker path
  it("A3: intent → INTENT_CHANGED → worker → decision with intentId+intentVersion", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "e2e intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    const event = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();

    // Phase 12.4.4d: Subject-scoped worker.
    await processPendingEventsForSubject(fx.userId, 10, "p952-a3-worker");

    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId, intentVersion: intent.version },
      orderBy: { createdAt: "desc" },
    });
    expect(decision).not.toBeNull();
    expect(decision?.reasonCodes).not.toBeNull();
  }, 60_000);

  // A4: Zero budget (maxPriceMinor=0) — valid constraint, not "no budget"
  it("A4: budget=0 with priced offer → budget evaluated (not skipped)", async () => {
    // Directly call makeDecision with budget=0 and the existing priced offers
    // (A=450, B=700) — both should be over budget since 0 < 450
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "free connectivity only",
      mode: "MANUAL",
      maxPriceMinor: 0,
    });

    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: intent.intentId,
      intentVersion: intent.version,
      sessionId: fx.sessionId,
      maxPriceMinor: 0, // zero budget — must be evaluated, NOT treated as absent
    });

    const persisted = await db.connectivityDecision.findUnique({
      where: { id: decision.decisionId },
      select: { constraintsSatisfied: true, constraintsViolated: true, reasonCodes: true },
    });
    const satisfied = JSON.parse(persisted?.constraintsSatisfied || "[]");
    const violated = JSON.parse(persisted?.constraintsViolated || "[]");
    const codes = JSON.parse(persisted?.reasonCodes || "[]");

    // Budget=0 was evaluated — both offers (450, 700) are over budget
    expect(violated).toContain("OVER_BUDGET");
    expect(codes).toContain("BUDGET_CONSTRAINT");
    // NOT skipped (the old truthiness bug would have skipped this entirely)
    expect(satisfied).not.toContain("BUDGET_APPLICABILITY_UNKNOWN");
  }, 30_000);

  // A5: Over-budget-only candidate → ACTIVATE becomes ASK_USER
  it("A5: only candidate over budget → action ASK_USER (not ACTIVATE)", async () => {
    // Create a fresh tenant with only one offer priced at 700 (over a 500 budget)
    const { hashPassword } = await import("@/lib/security");
    const overBudgetUser = await db.user.create({
      data: { email: `p955-${Date.now()}@test`, name: "Over Budget", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() },
    });
    const obTenant = await db.tenant.create({ data: { name: `P955 ${Date.now()}`, slug: `p955-${Date.now().toString(36)}`, status: "active" } });
    const obPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
    const obSub = await db.tenantSubscription.create({ data: { tenantId: obTenant.id, saaasPlanId: obPlan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
    const obCap = await db.connectivityCapability.findUnique({ where: { type: "INTERNET" } });
    const obEnt = await db.connectivityEntitlement.create({ data: { tenantId: obTenant.id, subscriptionId: obSub.id, capabilityId: obCap!.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 300 }), validFrom: new Date(), userId: overBudgetUser.id } });
    const obPi = await db.connectivityProviderInstance.create({ data: { tenantId: obTenant.id, providerType: "mock", name: `P955 PI`, status: "active", configuration: JSON.stringify({}) } });
    const obCapA = await db.protocolCapability.create({ data: { tenantId: obTenant.id, providerInstanceId: obPi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
    const obResA = await db.protocolResource.create({ data: { capabilityId: obCapA.id, providerInstanceId: obPi.id, identifiers: JSON.stringify({ id: "OB-A" }), state: "AVAILABLE" } });
    const obOffer = await db.connectivityOffer2.create({
      data: {
        tenantId: obTenant.id, capabilityId: obCapA.id,
        capabilityType: "INTERNET", providerType: "mock",
        spec: JSON.stringify({ downloadMbps: 300 }), coverage: JSON.stringify({ countries: ["GH"] }),
        wholesalePriceMinor: 500, customerPriceMinor: 700, currency: "USD", status: "active",
      },
    });
    await createOrUpdatePolicy({ subjectId: overBudgetUser.id, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });

    try {
      const intent = await createIntent({
        subjectId: overBudgetUser.id,
        rawText: "connectivity under $5",
        mode: "AUTOMATIC",
        maxPriceMinor: 500,
      });

      // Phase 12.4.4d: Subject-scoped worker.
      await processPendingEventsForSubject(overBudgetUser.id, 10, "p955-a5-worker");

      const decision = await db.connectivityDecision.findFirst({
        where: { intentId: intent.intentId },
        orderBy: { createdAt: "desc" },
        select: { action: true, constraintsViolated: true, reasonCodes: true },
      });
      expect(decision).not.toBeNull();
      const violated = JSON.parse(decision?.constraintsViolated || "[]");
      const codes = JSON.parse(decision?.reasonCodes || "[]");

      // The only candidate (700) is over budget (500)
      expect(violated).toContain("OVER_BUDGET");
      expect(codes).toContain("BUDGET_CONSTRAINT");
      // ACTIVATE should have been downgraded to ASK_USER
      expect(decision?.action).toBe("ASK_USER");
    } finally {
      await db.connectivityIntentRecord.deleteMany({ where: { subjectId: overBudgetUser.id } }).catch(() => {});
      await db.reevaluationEvent.deleteMany({ where: { subjectId: overBudgetUser.id } }).catch(() => {});
      await db.connectivityDecision.deleteMany({ where: { intentId: { contains: "intent-" } } }).catch(() => {});
      await db.connectivityOffer2.deleteMany({ where: { id: obOffer.id } }).catch(() => {});
      await db.protocolResource.deleteMany({ where: { id: obResA.id } }).catch(() => {});
      await db.protocolCapability.deleteMany({ where: { id: obCapA.id } }).catch(() => {});
      await db.connectivityProviderInstance.deleteMany({ where: { id: obPi.id } }).catch(() => {});
      await db.connectivityEntitlement.deleteMany({ where: { id: obEnt.id } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { id: obSub.id } }).catch(() => {});
      await db.connectivityPolicy.deleteMany({ where: { subjectId: overBudgetUser.id } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: obTenant.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: overBudgetUser.id } }).catch(() => {});
    }
  }, 120_000);
});
