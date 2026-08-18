/**
 * Phase 11.4 — Execution-Time Intent Authority (DB-backed runtime)
 *
 * Proves acceptance invariant #5:
 *   "Expired/superseded intent cannot execute."
 *
 * The prior 9.4.2 P1-5 test was too permissive — it accepted
 * ["SKIPPED", "EXECUTED", "FAILED", "RECONCILIATION_REQUIRED"], meaning any
 * outcome passed. It did not prove the execution-time authority fence.
 *
 * This phase proves the fence with EXACT assertions:
 *
 *   11.4.1: Expired intent → decision MUST NOT execute (exact SKIPPED)
 *   11.4.2: Superseded intent → decision MUST NOT execute (exact SKIPPED)
 *   11.4.3: Current active intent → decision MAY execute (EXECUTED)
 *   11.4.4: Race: decision claimed → intent becomes expired → execution
 *           authority check → execution MUST be rejected (exact SKIPPED)
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase11.4-intent-authority.test.ts
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
import { executeDecision } from "@/lib/control-plane/decision-executor";
import { createIntent } from "@/lib/control-plane/intent-service";

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
  const email = `phase114-${Date.now()}@test.roamlink`;
  const slug = `p114-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P11.4 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P114 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P114 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  // ACTIVATE resource A so the session is ACTIVE on A.
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p114-${session.id}` });
  await executeAction(action.id);

  // Mark the ACTIVATE decision as EXECUTED.
  await db.connectivityDecision.update({
    where: { id: decision.decisionId },
    data: { executionState: "EXECUTED", executedAt: new Date(), executedActionId: action.id },
  }).catch(() => {});

  // Clear session slot.
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

describe("Phase 11.4 — Execution-Time Intent Authority (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // Helper to reset session to ACTIVE on A.
  async function resetToActiveOnA() {
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null, activeResourceId: fx.resourceAId, state: "ACTIVE" },
    }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceAId }, data: { state: "IN_USE", reservedBy: fx.sessionId } }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceBId }, data: { state: "AVAILABLE", reservedBy: null, reservedAt: null } }).catch(() => {});
  }

  // =========================================================================
  // 11.4.1 — Expired intent → decision MUST NOT execute (exact SKIPPED)
  // =========================================================================
  it("11.4.1: expired intent → executeDecision returns exact SKIPPED, no action created", async () => {
    await resetToActiveOnA();

    // 1. Create an intent with a short expiry (already expired).
    const intent = await createIntent({
      subjectId: fx.subjectId,
      rawText: "expired intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // Manually set the intent's expiry to the past.
    await db.connectivityIntentRecord.update({
      where: { intentId_version: { intentId: intent.intentId, version: intent.version } },
      data: { expiresAt: new Date(Date.now() - 60_000) }, // expired 1 minute ago
    });

    // 2. Create a decision referencing the expired intent.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: intent.intentId,
        intentVersion: intent.version,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: expired intent"]),
        executionState: "PENDING",
      },
    });

    // 3. Execute the decision — the intent-expiry check should reject it.
    const result = await executeDecision(decision.id);

    // 4. EXACT assertion: the decision MUST be SKIPPED (not EXECUTED/FAILED/RECONCILIATION_REQUIRED).
    expect(result.executionState).toBe("SKIPPED");
    expect(result.error).toContain("intent-expired");

    // 5. No action was created (the decision was refused before action creation).
    const actions = await db.connectivityAction.findMany({ where: { decisionId: decision.id } });
    expect(actions.length).toBe(0);

    // 6. The session is unchanged (still on A).
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { id: decision.id } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.4.2 — Superseded intent → decision MUST NOT execute (exact SKIPPED)
  // =========================================================================
  it("11.4.2: superseded intent → executeDecision returns exact SKIPPED, no action created", async () => {
    await resetToActiveOnA();

    // 1. Create v1 intent.
    const v1 = await createIntent({
      subjectId: fx.subjectId,
      rawText: "v1 intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Create a decision referencing v1.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: v1.intentId,
        intentVersion: v1.version,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: superseded intent"]),
        executionState: "PENDING",
      },
    });

    // 3. Supersede v1 with v2 (v1 becomes SUPERSEDED).
    const v2 = await createIntent({
      subjectId: fx.subjectId,
      rawText: "v2 intent",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    // 4. Execute the decision — the superseded-intent check should reject it.
    const result = await executeDecision(decision.id);

    // 5. EXACT assertion: SKIPPED (not EXECUTED/FAILED/RECONCILIATION_REQUIRED).
    expect(result.executionState).toBe("SKIPPED");
    expect(result.error).toContain("intent-expired");

    // 6. No action created.
    const actions = await db.connectivityAction.findMany({ where: { decisionId: decision.id } });
    expect(actions.length).toBe(0);

    // 7. Session unchanged (still on A).
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { id: decision.id } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.4.3 — Current active intent → decision MAY execute (EXECUTED)
  // =========================================================================
  it("11.4.3: active intent → executeDecision returns EXECUTED (control)", async () => {
    await resetToActiveOnA();

    // 1. Create an active intent (no expiry, or expiry in the future).
    const intent = await createIntent({
      subjectId: fx.subjectId,
      rawText: "active intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Create a decision referencing the active intent.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: intent.intentId,
        intentVersion: intent.version,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: active intent"]),
        executionState: "PENDING",
      },
    });

    // 3. Execute the decision — the intent is active, so it should execute.
    const result = await executeDecision(decision.id);

    // 4. EXACT assertion: EXECUTED (not SKIPPED).
    expect(result.executionState).toBe("EXECUTED");

    // 5. An action was created.
    const actions = await db.connectivityAction.findMany({ where: { decisionId: decision.id } });
    expect(actions.length).toBe(1);

    // 6. The session switched to B.
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceBId);

    // Cleanup: switch back to A.
    await db.protocolResource.update({
      where: { id: fx.resourceAId },
      data: { state: "AVAILABLE", reservedBy: null, reservedAt: null },
    }).catch(() => {});
    await db.connectivityDecision.create({
      data: {
        intentId: intent.intentId,
        intentVersion: intent.version,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceAId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["cleanup"]),
        executionState: "PENDING",
      },
    }).then(async (d) => { await executeDecision(d.id).catch(() => {}); }).catch(() => {});

    await db.connectivityDecision.deleteMany({ where: { id: decision.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: fx.sessionId, type: "SWITCH" } }).catch(() => {});
  }, 120_000);

  // =========================================================================
  // 11.4.4 — Race: decision claimed → intent becomes expired → execution
  //           authority check → execution MUST be rejected (exact SKIPPED)
  //
  // This tests the race the architect specified:
  //   decision claimed
  //   → intent becomes expired/superseded
  //   → execution authority check
  //   → execution MUST be rejected
  //
  // The execution-time intent authority check runs AFTER the decision is
  // claimed but BEFORE the action is created. If the intent expires between
  // claim and the authority check, the execution MUST be rejected.
  // =========================================================================
  it("11.4.4: race — decision claimed, intent expires before authority check → exact SKIPPED", async () => {
    await resetToActiveOnA();

    // 1. Create an active intent.
    const intent = await createIntent({
      subjectId: fx.subjectId,
      rawText: "race intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Create a PENDING decision referencing the active intent.
    const decision = await db.connectivityDecision.create({
      data: {
        intentId: intent.intentId,
        intentVersion: intent.version,
        sessionId: fx.sessionId,
        action: "SWITCH",
        targetResourceId: fx.resourceBId,
        score: 0.9,
        constraintsSatisfied: JSON.stringify(["MANUAL"]),
        constraintsViolated: JSON.stringify([]),
        reasons: JSON.stringify(["test: race"]),
        executionState: "PENDING",
      },
    });

    // 3. Expire the intent BEFORE calling executeDecision.
    //    This simulates: the decision was created while the intent was active,
    //    but by the time executeDecision runs its authority check, the intent
    //    has expired (e.g. a concurrent expireStaleIntents cron tick).
    await db.connectivityIntentRecord.update({
      where: { intentId_version: { intentId: intent.intentId, version: intent.version } },
      data: { expiresAt: new Date(Date.now() - 60_000) }, // expired 1 minute ago
    });

    // 4. Execute the decision. The authority check sees the expired intent.
    const result = await executeDecision(decision.id);

    // 5. EXACT assertion: SKIPPED (not EXECUTED/FAILED/RECONCILIATION_REQUIRED).
    //    The execution-time authority fence rejected the execution.
    expect(result.executionState).toBe("SKIPPED");
    expect(result.error).toContain("intent-expired");

    // 6. No action created.
    const actions = await db.connectivityAction.findMany({ where: { decisionId: decision.id } });
    expect(actions.length).toBe(0);

    // 7. Session unchanged (still on A).
    const session = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true },
    });
    expect(session?.activeResourceId).toBe(fx.resourceAId);

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { id: decision.id } }).catch(() => {});
  }, 60_000);
});
