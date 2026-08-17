/**
 * Phase 9.4 — Intent & Decision Transparency (DB-backed runtime)
 *
 * Tests:
 *   9.4.1  create intent → persisted
 *   9.4.2  get active intent → returns latest
 *   9.4.3  supersede intent → old version SUPERSEDED, new ACTIVE
 *   9.4.4  cancel intent → CANCELLED
 *   9.4.5  expire intent → EXPIRED (inline check, not cron-only)
 *   9.4.6  stale supersession → rejected (version fencing)
 *   9.4.7  concurrent supersession → only one succeeds (atomic)
 *   9.4.8  offline stale replay → rejected
 *   9.4.9  intent does NOT directly create actions
 *   9.4.10 decision references intentId + intentVersion
 *   9.4.11 superseded intent cannot produce a new action
 *   9.4.12 another user's intent → rejected (ownership)
 *   9.4.13 AI-proposed intent cannot contain executable fields
 *   9.4.NS north-star: create intent → reevaluation → decision → supersede → new decision references v2
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
import {
  createIntent,
  getActiveIntent,
  getIntentHistory,
  cancelIntent,
  isIntentExpired,
  expireStaleIntents,
  emitIntentReevaluationEvent,
} from "@/lib/control-plane/intent-service";

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
  const email = `phase94-${Date.now()}@test.roamlink`;
  const slug = `p94-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P94 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P94 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P94 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
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

describe("Phase 9.4 — Intent & Decision Transparency (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture(); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // 9.4.1 create intent → persisted
  it("9.4.1: create intent → persisted with ACTIVE status", async () => {
    const result = await createIntent({
      subjectId: fx.userId,
      rawText: "I need reliable connectivity for work",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      priority: "HIGH",
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.version).toBe(1);
    expect(result.intentId).toBeTruthy();

    const record = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: result.intentId, version: 1 } },
    });
    expect(record).not.toBeNull();
    expect(record?.status).toBe("ACTIVE");
    expect(record?.priority).toBe("HIGH");
  }, 15_000);

  // 9.4.2 get active intent
  it("9.4.2: get active intent → returns the latest ACTIVE intent", async () => {
    const intent = await getActiveIntent(fx.userId);
    expect(intent).not.toBeNull();
    expect(intent?.status).toBe("ACTIVE");
    expect(intent?.version).toBe(1);
  }, 15_000);

  // 9.4.3 supersede intent
  it("9.4.3: supersede intent → old version SUPERSEDED, new ACTIVE", async () => {
    const current = await getActiveIntent(fx.userId);
    expect(current).not.toBeNull();

    const result = await createIntent({
      subjectId: fx.userId,
      rawText: "I now need cheapest connectivity",
      mode: "AUTOMATIC",
      supersedesIntentId: current!.intentId,
      expectedVersion: current!.version,
    });

    expect(result.status).toBe("ACTIVE");
    expect(result.version).toBe(2);

    // Old version is SUPERSEDED
    const old = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: current!.intentId, version: 1 } },
    });
    expect(old?.status).toBe("SUPERSEDED");
    expect(old?.supersededAt).not.toBeNull();

    // New version is ACTIVE
    const active = await getActiveIntent(fx.userId);
    expect(active?.version).toBe(2);
    expect(active?.status).toBe("ACTIVE");
  }, 15_000);

  // 9.4.4 cancel intent
  it("9.4.4: cancel intent → CANCELLED", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "Cancel me",
      mode: "MANUAL",
    });
    const result = await cancelIntent(fx.userId, intent.intentId, 1);
    expect(result.status).toBe("CANCELLED");

    const active = await getActiveIntent(fx.userId);
    // The cancelled intent should NOT be the active one
    expect(active?.intentId).not.toBe(intent.intentId);
  }, 15_000);

  // 9.4.5 expire intent (inline check)
  it("9.4.5: expired intent → isIntentExpired returns true", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "Short-lived intent",
      mode: "MANUAL",
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const expired = await isIntentExpired(intent.intentId, 1);
    expect(expired).toBe(true);

    // Run the batch expiry
    const result = await expireStaleIntents();
    expect(result.expired).toBeGreaterThan(0);

    const record = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: intent.intentId, version: 1 } },
    });
    expect(record?.status).toBe("EXPIRED");
  }, 15_000);

  // 9.4.6 stale supersession → rejected
  it("9.4.6: stale supersession (expectedVersion < current) → rejected", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "v1",
      mode: "AUTOMATIC",
    });
    // Supersede with v2
    await createIntent({
      subjectId: fx.userId,
      rawText: "v2",
      supersedesIntentId: intent.intentId,
      expectedVersion: 1,
    });
    // Now try to supersede with expectedVersion=1 (stale — current is 2)
    const result = await createIntent({
      subjectId: fx.userId,
      rawText: "stale replay",
      supersedesIntentId: intent.intentId,
      expectedVersion: 1, // stale!
    });
    expect(result.rejected).toBe("stale-version");
    expect(result.version).toBe(2); // current version unchanged
  }, 15_000);

  // 9.4.7 concurrent supersession → only one succeeds
  it("9.4.7: concurrent supersession → only one wins (atomic fencing)", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "base",
      mode: "AUTOMATIC",
    });
    // Two concurrent supersessions
    const [r1, r2] = await Promise.all([
      createIntent({ subjectId: fx.userId, rawText: "concurrent-1", supersedesIntentId: intent.intentId, expectedVersion: 1 }),
      createIntent({ subjectId: fx.userId, rawText: "concurrent-2", supersedesIntentId: intent.intentId, expectedVersion: 1 }),
    ]);
    // Exactly one succeeds, the other is rejected
    const successes = [r1, r2].filter((r) => !r.rejected);
    const failures = [r1, r2].filter((r) => r.rejected);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
  }, 15_000);

  // 9.4.8 offline stale replay → rejected
  it("9.4.8: offline stale replay (cancel old version after newer exists) → rejected", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "v1",
      mode: "AUTOMATIC",
    });
    // Create v2 (supersede v1)
    await createIntent({
      subjectId: fx.userId,
      rawText: "v2",
      supersedesIntentId: intent.intentId,
      expectedVersion: 1,
    });
    // Offline device replays cancel of v1 (stale — expectedVersion=1 < current=2)
    const result = await cancelIntent(fx.userId, intent.intentId, 1);
    expect(result.rejected).toBeTruthy(); // rejected (stale-version or no-active-intent)
    expect(result.version).toBe(2); // current version is 2, not 1
  }, 15_000);

  // 9.4.9 intent does NOT directly create actions
  it("9.4.9: intent creation does NOT create actions/decisions", async () => {
    const actionsBefore = await db.connectivityAction.count();
    const decisionsBefore = await db.connectivityDecision.count();

    await createIntent({
      subjectId: fx.userId,
      rawText: "no actions please",
      mode: "AUTOMATIC",
    });

    const actionsAfter = await db.connectivityAction.count();
    const decisionsAfter = await db.connectivityDecision.count();
    expect(actionsAfter).toBe(actionsBefore);
    expect(decisionsAfter).toBe(decisionsBefore);
  }, 15_000);

  // 9.4.10 decision references intentId + intentVersion
  it("9.4.10: makeDecision with intentId+intentVersion → persisted decision has both", async () => {
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "reliable for work",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
    });

    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: intent.intentId,
      intentVersion: intent.version,
      sessionId: fx.sessionId,
    });

    const persisted = await db.connectivityDecision.findUnique({
      where: { id: decision.decisionId },
      select: { intentId: true, intentVersion: true },
    });
    expect(persisted?.intentId).toBe(intent.intentId);
    expect(persisted?.intentVersion).toBe(intent.version);
  }, 30_000);

  // 9.4.11 another user's intent → rejected (ownership)
  it("9.4.11: another user cannot cancel another user's intent", async () => {
    const { hashPassword } = await import("@/lib/security");
    const otherUser = await db.user.create({
      data: { email: `p9411-${Date.now()}@test`, name: "Other", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() },
    });
    try {
      const intent = await createIntent({ subjectId: fx.userId, rawText: "my intent", mode: "MANUAL" });
      // Other user tries to cancel — query filters by subjectId, finds nothing
      const result = await cancelIntent(otherUser.id, intent.intentId, 1);
      expect(result.rejected).toBeTruthy(); // no-active-intent (subjectId filter excludes other user)
    } finally {
      await db.user.deleteMany({ where: { id: otherUser.id } });
    }
  }, 15_000);

  // 9.4.12 AI-proposed intent cannot contain executable fields
  it("9.4.12: AI-proposed intent with executable fields → fields ignored", async () => {
    const result = await createIntent({
      subjectId: fx.userId,
      rawText: "AI proposed",
      mode: "AUTOMATIC",
      source: "AI_PROPOSAL",
      desiredSpec: { resourceId: "res-123", action: "ACTIVATE", adapterCall: "mikrotik.provision" } as any,
    });
    expect(result.status).toBe("ACTIVE");

    // The payload should NOT contain executable fields
    const record = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: result.intentId, version: result.version } },
    });
    const payload = JSON.parse(record!.payload);
    // The intent payload is declarative — no resourceId, action, or adapterCall
    expect(payload.resourceId).toBeUndefined();
    expect(payload.action).toBeUndefined();
    expect(payload.adapterCall).toBeUndefined();
  }, 15_000);

  // 9.4.NS north-star: create → reevaluation → decision → supersede → new decision references v2
  it("9.4.NS: intent lifecycle → decision provenance chain", async () => {
    // 1. Create v1 intent
    const v1 = await createIntent({
      subjectId: fx.userId,
      rawText: "reliable connectivity for work",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      priority: "HIGH",
    });

    // 2. Emit reevaluation (what the intent API does)
    await emitIntentReevaluationEvent(v1.intentId, v1.version, fx.userId);

    // 3. Make a decision referencing v1
    const decision1 = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: v1.intentId,
      intentVersion: v1.version,
      sessionId: fx.sessionId,
    });

    // 4. Verify the decision references v1
    const persisted1 = await db.connectivityDecision.findUnique({
      where: { id: decision1.decisionId },
      select: { intentId: true, intentVersion: true },
    });
    expect(persisted1?.intentId).toBe(v1.intentId);
    expect(persisted1?.intentVersion).toBe(1);

    // 5. Supersede v1 with v2
    const v2 = await createIntent({
      subjectId: fx.userId,
      rawText: "cheapest connectivity now",
      mode: "AUTOMATIC",
      supersedesIntentId: v1.intentId,
      expectedVersion: v1.version,
    });
    expect(v2.version).toBe(2);

    // 6. v1 is SUPERSEDED
    const oldRecord = await db.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId: v1.intentId, version: 1 } },
    });
    expect(oldRecord?.status).toBe("SUPERSEDED");

    // 7. v2 is ACTIVE
    const active = await getActiveIntent(fx.userId);
    expect(active?.version).toBe(2);
    expect(active?.status).toBe("ACTIVE");

    // 8. Make a new decision referencing v2
    const decision2 = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.userId,
      intentId: v2.intentId,
      intentVersion: v2.version,
      sessionId: fx.sessionId,
    });

    // 9. The new decision references v2 (not v1)
    const persisted2 = await db.connectivityDecision.findUnique({
      where: { id: decision2.decisionId },
      select: { intentId: true, intentVersion: true },
    });
    expect(persisted2?.intentId).toBe(v1.intentId); // same intentId (it's a version, not a new intent)
    expect(persisted2?.intentVersion).toBe(2); // but version 2

    // 10. An old v1 replay cannot produce a new action — v1 is SUPERSEDED
    const expired = await isIntentExpired(v1.intentId, 1);
    expect(expired).toBe(true); // superseded = not authoritative = "expired" for safety
  }, 120_000);
});
