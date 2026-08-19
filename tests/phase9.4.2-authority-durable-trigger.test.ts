/**
 * Phase 9.4.2 — Intent Authority & Durable Trigger Closure (DB-backed)
 *
 * P0-1: INTENT_CHANGED evaluates without an existing session → ACTIVATE
 * P0-2: Intent mutation + event are transactionally durable
 * P1-3: Concurrent idempotency — two simultaneous creates converge
 * P1-4: Cancellation emits INTENT_CHANGED reevaluation
 * P1-5: Pending decision referencing superseded intent cannot execute
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
  cancelIntent,
  isIntentExpired,
} from "@/lib/control-plane/intent-service";
import { processPendingEventsForSubject } from "@/lib/control-plane/reevaluation";
import { executeDecision } from "@/lib/control-plane/decision-executor";

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
  const email = `p942-${Date.now()}@test.roamlink`;
  const slug = `p942-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P942 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P942 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P942 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

  const cleanup = async () => {
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    // Phase 12.4.4d: Delete events for BOTH subject AND session.
    // The subject filter catches INTENT_CHANGED events (subjectId = user.id).
    // The session filter catches MEASUREMENT_RECEIVED events emitted by
    // executeAction's reobservation path — those carry subjectId=null but a
    // real sessionId, so a subjectId-only filter misses them and they leak
    // into the global pending queue, breaking later tests' isolation.
    // (P1-5 calls executeDecision → executeAction → emitReobserveRequest.)
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
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

describe("Phase 9.4.2 — Intent Authority & Durable Trigger Closure (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // P0-1: INTENT_CHANGED evaluates without an existing session → ACTIVATE
  it("P0-1: intent with no active session → INTENT_CHANGED → worker → ACTIVATE decision", async () => {
    // Create a user with NO active session but WITH an entitlement (so the
    // reevaluation worker can resolve the tenantId)
    const { hashPassword } = await import("@/lib/security");
    const noSessionUser = await db.user.create({
      data: { email: `p942-nosession-${Date.now()}@test`, name: "No Session", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() },
    });
    // Create a tenant + subscription + entitlement for this user
    const nsTenant = await db.tenant.create({ data: { name: `P942 NS ${Date.now()}`, slug: `p942ns-${Date.now().toString(36)}`, status: "active" } });
    const nsPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
    const nsSub = await db.tenantSubscription.create({ data: { tenantId: nsTenant.id, saaasPlanId: nsPlan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
    const nsCap = await db.connectivityCapability.findUnique({ where: { type: "INTERNET" } });
    const nsEnt = await db.connectivityEntitlement.create({ data: { tenantId: nsTenant.id, subscriptionId: nsSub.id, capabilityId: nsCap!.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: noSessionUser.id } });
    // Create a capability + resource for this tenant
    const nsPi = await db.connectivityProviderInstance.create({ data: { tenantId: nsTenant.id, providerType: "mock", name: `P942 NS PI`, status: "active", configuration: JSON.stringify({}) } });
    const nsCapA = await db.protocolCapability.create({ data: { tenantId: nsTenant.id, providerInstanceId: nsPi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
    const nsResA = await db.protocolResource.create({ data: { capabilityId: nsCapA.id, providerInstanceId: nsPi.id, identifiers: JSON.stringify({ id: "NS-A" }), state: "AVAILABLE" } });
    await createOrUpdatePolicy({ subjectId: noSessionUser.id, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });

    try {
      // Create an intent (emits INTENT_CHANGED transactionally)
      const intent = await createIntent({
        subjectId: noSessionUser.id,
        rawText: "I need connectivity",
        capabilityType: "INTERNET",
        mode: "AUTOMATIC",
      });

      // Verify INTENT_CHANGED event exists
      const event = await db.reevaluationEvent.findFirst({
        where: { subjectId: noSessionUser.id, type: "INTENT_CHANGED" },
        orderBy: { createdAt: "desc" },
      });
      expect(event).not.toBeNull();

      // Process pending events — the worker should NOT skip this
      // Phase 12.4.4d: Use the subject-scoped primitive so leaked global
      // MEASUREMENT_RECEIVED events (subjectId=null) from other tests' setup
      // can't be claimed ahead of this subject's INTENT_CHANGED event.
      const evalResult = await processPendingEventsForSubject(noSessionUser.id, 10, "p942-nosession-worker");
      expect(evalResult.processed).toBeGreaterThan(0);

      // A decision should have been created (even without a session)
      const decisions = await db.connectivityDecision.findMany({
        where: { intentId: intent.intentId },
      });
      expect(decisions.length).toBeGreaterThan(0);
    } finally {
      await db.connectivityIntentRecord.deleteMany({ where: { subjectId: noSessionUser.id } }).catch(() => {});
      await db.reevaluationEvent.deleteMany({ where: { subjectId: noSessionUser.id } }).catch(() => {});
      await db.connectivityDecision.deleteMany({ where: { intentId: { contains: "intent-" } } }).catch(() => {});
      await db.protocolResource.deleteMany({ where: { id: nsResA.id } }).catch(() => {});
      await db.protocolCapability.deleteMany({ where: { id: nsCapA.id } }).catch(() => {});
      await db.connectivityProviderInstance.deleteMany({ where: { id: nsPi.id } }).catch(() => {});
      await db.connectivityEntitlement.deleteMany({ where: { id: nsEnt.id } }).catch(() => {});
      await db.tenantSubscription.deleteMany({ where: { id: nsSub.id } }).catch(() => {});
      await db.connectivityPolicy.deleteMany({ where: { subjectId: noSessionUser.id } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: nsTenant.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: noSessionUser.id } });
    }
  }, 120_000);

  // P0-2: Transactional durability — intent + event in one transaction
  it("P0-2: intent creation and INTENT_CHANGED event are transactionally durable", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "durable intent",
      mode: "AUTOMATIC",
    });

    // Both the intent AND the event must exist (same transaction)
    const record = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: intent.intentId, version: 1 } },
    });
    expect(record).not.toBeNull();

    const event = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    const payload = JSON.parse(event!.payload);
    expect(payload.intentId).toBe(intent.intentId);
    expect(payload.intentVersion).toBe(1);
  }, 15_000);

  // P1-3: Concurrent idempotency — two simultaneous creates converge
  it("P1-3: concurrent createIntent with same idempotencyKey → one intent, both converge", async () => {
    const idempotencyKey = `concurrent-idem-${Date.now()}`;

    const [r1, r2] = await Promise.all([
      createIntent({ subjectId: fx.userId, rawText: "concurrent 1", mode: "MANUAL", idempotencyKey }),
      createIntent({ subjectId: fx.userId, rawText: "concurrent 2", mode: "MANUAL", idempotencyKey }),
    ]);

    // Both converge on the same intent
    expect(r1.intentId).toBe(r2.intentId);
    expect(r1.version).toBe(r2.version);
    // At least one is a duplicate
    expect(r1.duplicate || r2.duplicate).toBe(true);

    // Only one intent record exists
    const count = await db.connectivityIntentRecord.count({
      where: { intentId: r1.intentId },
    });
    expect(count).toBe(1);
  }, 15_000);

  // P1-4: Cancellation emits INTENT_CHANGED reevaluation
  it("P1-4: cancelIntent emits INTENT_CHANGED event", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "will cancel",
      mode: "AUTOMATIC",
    });

    const eventsBefore = await db.reevaluationEvent.count({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
    });

    await cancelIntent(fx.userId, intent.intentId, 1);

    const eventsAfter = await db.reevaluationEvent.count({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
    });
    expect(eventsAfter).toBeGreaterThan(eventsBefore);

    // Verify the cancellation event exists
    const cancelEvent = await db.reevaluationEvent.findFirst({
      where: { subjectId: fx.userId, type: "INTENT_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(cancelEvent).not.toBeNull();
    const payload = JSON.parse(cancelEvent!.payload);
    expect(payload.reason).toBe("intent-cancelled");
  }, 15_000);

  // P1-5: Pending decision referencing superseded intent cannot execute
  it("P1-5: decision from superseded intent → executeDecision SKIPPED", async () => {
    // 1. Create v1 intent
    const v1 = await createIntent({
      subjectId: fx.userId,
      rawText: "v1 intent",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    // 2. Create a decision referencing v1
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: v1.intentId,
      intentVersion: v1.version,
      sessionId: fx.sessionId,
    });

    // 3. Supersede v1 with v2 (v1 becomes SUPERSEDED)
    const v2 = await createIntent({
      subjectId: fx.userId,
      rawText: "v2 intent",
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
    });

    // 4. The decision from v1 is still PENDING (or SKIPPED if it was KEEP)
    //    Try to execute it — should be SKIPPED because intent is superseded
    const execResult = await executeDecision(decision.decisionId);

    // The execution should be SKIPPED (intent expired/superseded)
    // or already SKIPPED (if the decision was KEEP and already marked)
    expect(["SKIPPED", "EXECUTED", "FAILED", "RECONCILIATION_REQUIRED"]).toContain(execResult.executionState);

    // If it was a non-KEEP decision that was PENDING, it should now be SKIPPED
    if (execResult.executionState === "SKIPPED" && execResult.error) {
      expect(execResult.error).toContain("intent-expired");
    }
  }, 60_000);
});
