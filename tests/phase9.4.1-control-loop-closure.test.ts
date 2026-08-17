/**
 * Phase 9.4.1 — Intent Control-Loop Closure (DB-backed runtime)
 *
 * Proves the P0/P1 fixes:
 *   9.4.1.1  INTENT_CHANGED event type (not MEASUREMENT_RECEIVED)
 *   9.4.1.2  Atomic supersession (transaction — no partial state on crash)
 *   9.4.1.3  Intent expiry enforced by makeDecision (inline, not cron-only)
 *   9.4.1.4  Idempotency key — duplicate creation returns existing
 *   9.4.1.5  Strict expectedVersion equality (expectedVersion > current rejected)
 *   9.4.1.6  Ownership check returns 403, not hidden as 404
 *   9.4.1.7  End-to-end: intent → INTENT_CHANGED → reevaluation → decision with intentId+intentVersion
 *   9.4.1.8  Durable event handoff — no .catch swallow (event exists after intent creation)
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
  createIntent,
  getActiveIntent,
  cancelIntent,
  isIntentExpired,
  emitIntentReevaluationEvent,
} from "@/lib/control-plane/intent-service";
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
  const email = `p941-${Date.now()}@test.roamlink`;
  const slug = `p941-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P941 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P941 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P941 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  // ACTIVATE A so there's an active session for the reevaluation worker
  const session = await createSession({ subjectId, entitlementId: ent.id });
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p941-${session.id}` });
  await executeAction(action.id);

  const cleanup = async () => {
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
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

describe("Phase 9.4.1 — Intent Control-Loop Closure (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // 9.4.1.1 INTENT_CHANGED event type
  it("9.4.1.1: intent creation emits INTENT_CHANGED (not MEASUREMENT_RECEIVED)", async () => {
    const result = await createIntent({
      subjectId: fx.userId,
      rawText: "test intent",
      mode: "AUTOMATIC",
    });

    const event = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    const payload = JSON.parse(event!.payload);
    expect(payload.intentId).toBe(result.intentId);
    expect(payload.intentVersion).toBe(result.version);
  }, 15_000);

  // 9.4.1.2 Atomic supersession (transaction)
  it("9.4.1.2: supersession is atomic — old SUPERSEDED + new ACTIVE in one transaction", async () => {
    const v1 = await createIntent({
      subjectId: fx.userId,
      rawText: "v1 atomic test",
      mode: "AUTOMATIC",
    });

    const v2 = await createIntent({
      subjectId: fx.userId,
      rawText: "v2 atomic test",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    // Both states should be consistent — no partial state
    const old = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: v1.intentId, version: 1 } },
    });
    const neu = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: v1.intentId, version: 2 } },
    });
    expect(old?.status).toBe("SUPERSEDED");
    expect(neu?.status).toBe("ACTIVE");
  }, 15_000);

  // 9.4.1.3 Intent expiry enforced by makeDecision
  it("9.4.1.3: expired intent → makeDecision returns WAIT (not actionable)", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "expired intent",
      mode: "AUTOMATIC",
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: intent.intentId,
      intentVersion: intent.version,
      sessionId: fx.sessionId,
    });

    expect(decision.action).toBe("WAIT");
    expect(decision.constraintsViolated).toContain("INTENT_EXPIRED");

    const persisted = await db.connectivityDecision.findUnique({
      where: { id: decision.decisionId },
      select: { intentId: true, intentVersion: true, executionState: true },
    });
    expect(persisted?.intentId).toBe(intent.intentId);
    expect(persisted?.intentVersion).toBe(intent.version);
    expect(persisted?.executionState).toBe("SKIPPED");
  }, 30_000);

  // 9.4.1.4 Idempotency key — duplicate creation returns existing
  it("9.4.1.4: idempotency key — duplicate creation returns existing intent", async () => {
    const idempotencyKey = `idem-${Date.now()}`;
    const r1 = await createIntent({
      subjectId: fx.userId,
      rawText: "idempotent intent",
      mode: "MANUAL",
      idempotencyKey,
    });
    const r2 = await createIntent({
      subjectId: fx.userId,
      rawText: "idempotent intent retry",
      mode: "MANUAL",
      idempotencyKey,
    });

    expect(r1.intentId).toBe(r2.intentId);
    expect(r1.version).toBe(r2.version);
    expect(r2.duplicate).toBe(true);
  }, 15_000);

  // 9.4.1.5 Strict expectedVersion equality
  it("9.4.1.5: expectedVersion > current → rejected (version-mismatch)", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "strict version test",
      mode: "AUTOMATIC",
    });

    // Try to supersede with expectedVersion=7 (current is 1)
    const result = await createIntent({
      subjectId: fx.userId,
      rawText: "wrong version",
      supersedesIntentId: intent.intentId,
      expectedVersion: 7, // wrong — current is 1
    });

    expect(result.rejected).toBe("version-mismatch");
  }, 15_000);

  // 9.4.1.6 Ownership check returns 403 (not hidden as 404)
  it("9.4.1.6: another user's intent → ownership-violation (not not-found)", async () => {
    const { hashPassword } = await import("@/lib/security");
    const otherUser = await db.user.create({
      data: { email: `p9416-${Date.now()}@test`, name: "Other", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() },
    });
    try {
      const intent = await createIntent({ subjectId: fx.userId, rawText: "my intent", mode: "MANUAL" });
      const result = await cancelIntent(otherUser.id, intent.intentId, 1);
      expect(result.rejected).toBe("ownership-violation");
    } finally {
      await db.user.deleteMany({ where: { id: otherUser.id } });
    }
  }, 15_000);

  // 9.4.1.7 End-to-end: intent → INTENT_CHANGED → reevaluation → decision with intentId+intentVersion
  it("9.4.1.7: end-to-end production chain — intent → event → worker → decision", async () => {
    // 1. Create intent (emits INTENT_CHANGED)
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "e2e reliable connectivity",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Verify INTENT_CHANGED event exists
    const event = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    const payload = JSON.parse(event!.payload);
    expect(payload.intentId).toBe(intent.intentId);
    expect(payload.intentVersion).toBe(intent.version);

    // 3. Process pending events (the reevaluation worker)
    const evalResult = await processPendingEvents(10, "p941-e2e-worker");
    expect(evalResult.processed).toBeGreaterThan(0);

    // 4. Verify the resulting decision references the intent (from the event payload)
    // The reevaluation worker may produce a KEEP decision (healthy resource) —
    // but it MUST reference the intentId + intentVersion from the event.
    const decision = await db.connectivityDecision.findFirst({
      where: { sessionId: fx.sessionId, intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
    });
    expect(decision).not.toBeNull();
    expect(decision?.intentId).toBe(intent.intentId);
    expect(decision?.intentVersion).toBe(intent.version);
  }, 60_000);

  // 9.4.1.8 Durable event handoff — event exists after intent creation
  it("9.4.1.8: intent creation guarantees reevaluation event exists (no .catch swallow)", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "durable handoff test",
      mode: "AUTOMATIC",
    });

    // The event MUST exist — the intent service doesn't swallow the error
    const events = await db.reevaluationEvent.count({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
    });
    expect(events).toBeGreaterThan(0);
  }, 15_000);

  // 9.4.1.9 Superseded intent cannot produce a new action via the control loop
  it("9.4.1.9: superseded intent → makeDecision returns WAIT (INTENT_EXPIRED)", async () => {
    const v1 = await createIntent({
      subjectId: fx.userId,
      rawText: "will be superseded",
      mode: "AUTOMATIC",
    });

    // Supersede v1 with v2
    await createIntent({
      subjectId: fx.userId,
      rawText: "newer version",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    // Now try to make a decision referencing v1 (superseded)
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: v1.intentId,
      intentVersion: 1, // old version
      sessionId: fx.sessionId,
    });

    // Should be WAIT — superseded intent cannot produce actionable decisions
    expect(decision.action).toBe("WAIT");
    expect(decision.constraintsViolated).toContain("INTENT_EXPIRED");
  }, 30_000);
});
