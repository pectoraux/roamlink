/**
 * Phase 11.7 — End-to-End Auditability (DB-backed runtime)
 *
 * Proves acceptance invariant #8:
 *   "Every failed/recovered path is auditable."
 *
 * The architect's requirement:
 *   intent → decision → execution claim → action → failure/reconciliation →
 *   persistent terminal state → auditable correlation trail
 *
 * An operator should be able to reconstruct the incident from the persisted
 * records: the intent that triggered it, the decision that was made, the
 * execution claim that owned it, the action that was attempted, the
 * failure/reconciliation state, and the correlation IDs that link them all.
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase11.7-auditability.test.ts
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
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
import { setProviderTruthOverride, clearProviderTruthOverride } from "@/lib/control-plane/kernel-bridge";

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
  const email = `phase117-${Date.now()}@test.roamlink`;
  const slug = `p117-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P11.7 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P117 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P117 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p117-${session.id}` });
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

describe("Phase 11.7 — End-to-End Auditability (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);
  afterEach(() => { clearProviderTruthOverride(); });

  // =========================================================================
  // 11.7.1 — Full correlation trail: intent → decision → execution claim →
  //          action → failure (RECONCILIATION_REQUIRED) → persistent terminal
  //          state → auditable correlation IDs.
  //
  // An operator can reconstruct the incident by following the chain:
  //   ConnectivityIntentRecord → ConnectivityDecision → ConnectivityAction
  //   with intentId, intentVersion, executionClaimId, executedActionId,
  //   executionState, error all persisted and linked.
  // =========================================================================
  it("11.7.1: failure correlation trail — intent → decision → execution claim → action → RECONCILIATION_REQUIRED → auditable trail", async () => {
    // Reset session to ACTIVE on A.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { executionSlotClaimId: null, executionSlotClaimedAt: null, executionSlotClaimExpiresAt: null, activeResourceId: fx.resourceAId, state: "ACTIVE", entitlementId: fx.entitlementId },
    }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceAId }, data: { state: "IN_USE", reservedBy: fx.sessionId } }).catch(() => {});
    await db.protocolResource.update({ where: { id: fx.resourceBId }, data: { state: "AVAILABLE", reservedBy: null, reservedAt: null } }).catch(() => {});

    // 1. Create an intent (the trigger).
    const intent = await createIntent({
      subjectId: fx.subjectId,
      rawText: "auditability test intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Create a PENDING decision referencing the intent.
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
        reasons: JSON.stringify(["test: auditability"]),
        executionState: "PENDING",
      },
    });

    // 3. Inject a provider-truth flip to NOT_USABLE at the verify boundary.
    setProviderTruthOverride((resourceId) => {
      if (resourceId === fx.resourceBId) {
        return { status: "NOT_USABLE", reason: "Auditability test: provider truth flipped" };
      }
      return null;
    });

    // 4. Execute the decision. It should reach RECONCILIATION_REQUIRED.
    const result = await executeDecision(decision.id);

    // 5. The execution result should be RECONCILIATION_REQUIRED.
    expect(result.executionState).toBe("RECONCILIATION_REQUIRED");

    // --- Auditability trail: an operator can reconstruct the incident ---

    // 6. The ConnectivityDecision has persistent terminal state + correlation IDs.
    const dbDecision = await db.connectivityDecision.findUnique({
      where: { id: decision.id },
      select: {
        id: true,
        intentId: true,
        intentVersion: true,
        sessionId: true,
        action: true,
        targetResourceId: true,
        executionState: true,
        executionClaimId: true,
        executionAttemptCount: true,
        executedAt: true,
        executedActionId: true,
      },
    });

    // The decision is RECONCILIATION_REQUIRED (terminal, not EXECUTED).
    expect(dbDecision?.executionState).toBe("RECONCILIATION_REQUIRED");
    // It references the intent.
    expect(dbDecision?.intentId).toBe(intent.intentId);
    expect(dbDecision?.intentVersion).toBe(intent.version);
    // It has an execution claim (the worker that attempted it).
    expect(dbDecision?.executionClaimId).not.toBeNull();
    // It has an executed action ID (the action that was attempted).
    expect(dbDecision?.executedActionId).not.toBeNull();
    // It has an executedAt timestamp.
    expect(dbDecision?.executedAt).not.toBeNull();
    // It has an attempt count (at least 1).
    expect(dbDecision?.executionAttemptCount).toBeGreaterThanOrEqual(1);

    // 7. The ConnectivityAction is linked and has a terminal state.
    const actionId = dbDecision?.executedActionId;
    expect(actionId).toBeDefined();
    const dbAction = await db.connectivityAction.findUnique({
      where: { id: actionId },
      select: {
        id: true,
        sessionId: true,
        decisionId: true,
        type: true,
        targetResourceId: true,
        state: true,
        error: true,
        completedAt: true,
      },
    });

    // The action is RECONCILIATION_REQUIRED (not SUCCEEDED).
    expect(dbAction?.state).toBe("RECONCILIATION_REQUIRED");
    // The action is linked back to the decision.
    expect(dbAction?.decisionId).toBe(decision.id);
    // The action has an error message describing the failure reason.
    expect(dbAction?.error).not.toBeNull();
    expect(dbAction?.error).toContain("NOT_USABLE");

    // 8. The ConnectivityIntentRecord is still persisted (the trigger).
    const dbIntent = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: intent.intentId, version: intent.version } },
      select: { intentId: true, version: true, status: true, payload: true },
    });
    expect(dbIntent?.intentId).toBe(intent.intentId);
    expect(dbIntent?.version).toBe(intent.version);

    // 9. The ConnectivitySession is still ACTIVE on A (the failure did not
    //    corrupt the session — the target was released, the old resource retained).
    const dbSession = await db.connectivitySession.findUnique({
      where: { id: fx.sessionId },
      select: { activeResourceId: true, state: true },
    });
    expect(dbSession?.activeResourceId).toBe(fx.resourceAId);
    expect(dbSession?.state).toBe("ACTIVE");

    // 10. The target resource (B) was released (not orphaned).
    const resB = await db.protocolResource.findUnique({
      where: { id: fx.resourceBId },
      select: { state: true, reservedBy: true },
    });
    expect(resB?.state).not.toBe("IN_USE");
    expect(resB?.reservedBy).not.toBe(fx.sessionId);

    // --- Operator reconstruction summary ---
    // An operator can follow: intent (intentId+version) → decision (intentId+version,
    // executionClaimId, executedActionId, executionState) → action (decisionId,
    // state, error, completedAt) → session (activeResourceId, state) → resource
    // (state, reservedBy). Every link in the chain is persisted + correlated.

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { id: decision.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: fx.sessionId, type: "SWITCH" } }).catch(() => {});
  }, 120_000);
});
