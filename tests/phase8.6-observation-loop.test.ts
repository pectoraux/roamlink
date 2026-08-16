/**
 * Phase 8.6 — Continuous Connectivity Observation (DB-backed runtime)
 *
 * This is the north-star runtime test. Unlike all prior Phase 8 tests (static
 * source inspection), this test executes the FULL control loop against the
 * real PostgreSQL database and the mock provider adapter:
 *
 *   Fixture: Tenant, Subscription, ConnectivityCapability(INTERNET),
 *            ProtocolCapability A + Resource A (healthy spec),
 *            ProtocolCapability B + Resource B (healthy spec),
 *            entitlement (userId=subject) + 2 pre-provisioned mock bindings.
 *
 *   1. ACTIVATE A → kernel bridge → mock adapter reconcile → A IN_USE → invariant → Session A ACTIVE
 *   2. inject 3 degraded measurements on A (source=ADAPTER) → deriveResourceHealth(A) = DEGRADED
 *   3. freshness: FRESH measurement classified correctly
 *   4. triggerReevaluation → makeDecision → SWITCH B (policy ALLOW)
 *   5. execute SWITCH → kernel bridge → mock adapter reconcile B → B IN_USE, A released → invariant → Session B ACTIVE
 *   6. freshness gate: a STALE health snapshot must NOT trigger an automatic switch
 *
 * Requires DATABASE_URL (PostgreSQL). Run via: bun test tests/phase8.6-observation-loop.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { mockConnectivityProvider } from "@/lib/connectivity";
import type { ConnectivityEntitlementInput, ProviderResourceBindingInput } from "@/lib/connectivity/adapter";
import { createSession, transitionSessionState } from "@/lib/control-plane/session-manager";
import { makeDecision } from "@/lib/control-plane/decision-engine";
import { createAction, executeAction, recoverStaleActions } from "@/lib/control-plane/action-executor";
import { ingestMeasurement } from "@/lib/control-plane/measurement-store";
import { deriveResourceHealth, getResourceHealth } from "@/lib/control-plane/health-derivation";
import { classifyFreshness } from "@/lib/control-plane/freshness";
import { triggerReevaluation } from "@/lib/control-plane/reevaluation";
import { assertActiveConnectivityInvariant } from "@/lib/control-plane/invariant-checker";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  subscriptionId: string;
  subjectId: string;
  capabilityAId: string;
  resourceAId: string;
  capabilityBId: string;
  resourceBId: string;
  entitlementId: string;
  bindingAId: string;
  bindingBId: string;
  providerInstanceId: string;
  sessionId: string;
  providerResourceA: string;
  providerResourceB: string;
  cleanup: () => Promise<void>;
};

async function provisionMockResource(
  entitlementId: string,
  providerInstanceId: string,
): Promise<string> {
  // Call the mock adapter's provision() to populate its in-memory resource map
  // so subsequent reconcile() calls return in_sync.
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: entitlementId },
    include: { capability: { select: { type: true } } },
  });
  const entInput: ConnectivityEntitlementInput = {
    id: entitlement!.id,
    tenantId: entitlement!.tenantId,
    subscriptionId: entitlement!.subscriptionId,
    status: entitlement!.status,
    capabilityType: entitlement!.capability?.type ?? "INTERNET",
    capabilitySet: JSON.parse(entitlement!.capabilitySet),
    policy: entitlement!.policy ? JSON.parse(entitlement!.policy) : null,
    validFrom: entitlement!.validFrom,
    validUntil: entitlement!.validUntil ?? null,
  };
  const bindingInput: ProviderResourceBindingInput = {
    id: "fixture-binding",
    entitlementId,
    providerType: "mock",
    providerResourceId: null,
    providerMetadata: null,
    status: "UNBOUND",
    provisioningState: null,
    providerInstanceId,
    providerInstanceConfiguration: null,
  };
  const result = await mockConnectivityProvider.provision({ entitlement: entInput, binding: bindingInput });
  if (!result.providerResourceId) throw new Error("mock provision did not return a providerResourceId");
  return result.providerResourceId;
}

async function setupFixture(): Promise<Fixture> {
  const subjectId = `phase86-subject-${Date.now()}`;
  const slug = `phase86-${Date.now().toString(36)}`;

  // 1. Tenant
  const tenant = await db.tenant.create({
    data: { name: `Phase 8.6 Tenant ${slug}`, slug, status: "active" },
  });

  // 2. Subscription (active) — references an existing SaaasPlan (starter)
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter SaaasPlan not found — run db:seed first");
  const subscription = await db.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      saaasPlanId: starterPlan.id,
      status: "active",
      billingCycle: "monthly",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  // 3. ConnectivityCapability (INTERNET) — required FK for entitlement
  const capType = "INTERNET";
  let connectivityCapability = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!connectivityCapability) {
    connectivityCapability = await db.connectivityCapability.create({
      data: { type: capType, displayName: "Internet", description: "Internet connectivity" },
    });
  }

  // 4. Provider instance (mock)
  const providerInstance = await db.connectivityProviderInstance.create({
    data: {
      tenantId: tenant.id,
      providerType: "mock",
      name: `Phase 8.6 Mock ${slug}`,
      status: "active",
      configuration: JSON.stringify({}),
    },
  });

  // 5. Entitlement (userId=subject — the schema drift fix makes this queryable)
  const entitlement = await db.connectivityEntitlement.create({
    data: {
      tenantId: tenant.id,
      subscriptionId: subscription.id,
      capabilityId: connectivityCapability.id,
      status: "ACTIVE",
      capabilitySet: JSON.stringify({ downloadMbps: 500, uploadMbps: 100 }),
      validFrom: new Date(),
      userId: subjectId,
    },
  });

  // 6. Two protocol capabilities + resources (A and B)
  const capabilityA = await db.protocolCapability.create({
    data: {
      tenantId: tenant.id,
      providerInstanceId: providerInstance.id,
      type: "INTERNET",
      providerType: "mock",
      technicalSpec: JSON.stringify({ downloadMbps: 500, uploadMbps: 100, typicalLatencyMs: 20 }),
      coverage: JSON.stringify({ countries: ["GH"], cities: ["Accra"] }),
      reliability: 0.92,
      status: "active",
    },
  });
  const resourceA = await db.protocolResource.create({
    data: {
      capabilityId: capabilityA.id,
      providerInstanceId: providerInstance.id,
      identifiers: JSON.stringify({ hotspotId: "A" }),
      capacity: JSON.stringify({ totalBandwidthMbps: 500, availableBandwidthMbps: 500 }),
      state: "AVAILABLE",
    },
  });

  const capabilityB = await db.protocolCapability.create({
    data: {
      tenantId: tenant.id,
      providerInstanceId: providerInstance.id,
      type: "INTERNET",
      providerType: "mock",
      technicalSpec: JSON.stringify({ downloadMbps: 300, uploadMbps: 50, typicalLatencyMs: 10 }),
      coverage: JSON.stringify({ countries: ["GH"], cities: ["Accra"] }),
      reliability: 0.9,
      status: "active",
    },
  });
  const resourceB = await db.protocolResource.create({
    data: {
      capabilityId: capabilityB.id,
      providerInstanceId: providerInstance.id,
      identifiers: JSON.stringify({ hotspotId: "B" }),
      capacity: JSON.stringify({ totalBandwidthMbps: 300, availableBandwidthMbps: 300 }),
      state: "AVAILABLE",
    },
  });

  // 7. Pre-provision two mock adapter resources + create two bindings linked
  //    to the resources. This ensures reconcile() returns in_sync.
  const providerResourceA = await provisionMockResource(entitlement.id, providerInstance.id);
  const bindingA = await db.providerResourceBinding.create({
    data: {
      entitlementId: entitlement.id,
      providerType: "mock",
      resourceType: "hotspot_user",
      providerResourceId: providerResourceA,
      providerMetadata: JSON.stringify({ mock: true }),
      status: "BOUND",
      provisioningState: "COMPLETED",
      providerInstanceId: providerInstance.id,
    },
  });
  await db.protocolResource.update({ where: { id: resourceA.id }, data: { providerBindingId: bindingA.id } });

  const providerResourceB = await provisionMockResource(entitlement.id, providerInstance.id);
  const bindingB = await db.providerResourceBinding.create({
    data: {
      entitlementId: entitlement.id,
      providerType: "mock",
      resourceType: "hotspot_user",
      providerResourceId: providerResourceB,
      providerMetadata: JSON.stringify({ mock: true }),
      status: "BOUND",
      provisioningState: "COMPLETED",
      providerInstanceId: providerInstance.id,
    },
  });
  await db.protocolResource.update({ where: { id: resourceB.id }, data: { providerBindingId: bindingB.id } });

  // 8. Automatic policy (so SWITCH is allowed without user approval)
  await createOrUpdatePolicy({
    subjectId,
    preset: "RELIABLE",
    mode: "automatic",
    maxAutoSpendMinor: 10000,
    requireUserApprovalForPurchase: false,
  });

  // 9. Session
  const session = await createSession({ subjectId, entitlementId: entitlement.id });

  const cleanup = async () => {
    // Delete in dependency order
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resourceA.id, resourceB.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resourceA.id, resourceB.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capabilityA.id, capabilityB.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bindingA.id, bindingB.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: entitlement.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: providerInstance.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
  };

  return {
    tenantId: tenant.id,
    subscriptionId: subscription.id,
    subjectId,
    capabilityAId: capabilityA.id,
    resourceAId: resourceA.id,
    capabilityBId: capabilityB.id,
    resourceBId: resourceB.id,
    entitlementId: entitlement.id,
    bindingAId: bindingA.id,
    bindingBId: bindingB.id,
    providerInstanceId: providerInstance.id,
    sessionId: session.id,
    providerResourceA,
    providerResourceB,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 8.6 — Continuous Connectivity Observation (DB-backed runtime)", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupFixture();
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 1. ACTIVATE A via the full path
  // -------------------------------------------------------------------------
  it("8.6.1: ACTIVATE A → kernel bridge → mock adapter reconcile → invariant → Session A ACTIVE", async () => {
    // Make a decision (no active session → ACTIVATE)
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.subjectId,
      sessionId: fx.sessionId,
      capabilityType: "INTERNET",
    });

    expect(decision.action).toBe("ACTIVATE");
    expect(decision.targetResourceId).toBe(fx.resourceAId);

    // Create + execute the action
    const action = await createAction({
      sessionId: fx.sessionId,
      decisionId: decision.decisionId,
      type: "ACTIVATE",
      targetResourceId: decision.targetResourceId,
      idempotencyKey: `phase86-activate-${fx.sessionId}`,
    });

    const result = await executeAction(action.id);
    expect(result.status).toBe("succeeded");

    // Session is now ACTIVE on A
    const session = await db.connectivitySession.findUnique({ where: { id: fx.sessionId } });
    expect(session?.state).toBe("ACTIVE");
    expect(session?.activeResourceId).toBe(fx.resourceAId);
    expect(session?.entitlementId).toBe(fx.entitlementId);

    // Resource A is IN_USE, owned by the session
    const resourceA = await db.protocolResource.findUnique({ where: { id: fx.resourceAId } });
    expect(resourceA?.state).toBe("IN_USE");
    expect(resourceA?.reservedBy).toBe(fx.sessionId);

    // The invariant holds (provider truth + session + resource + binding + entitlement converge)
    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(true);
    expect(invariant.violations).toEqual([]);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 2. Inject 3 degraded measurements → health DEGRADED
  // -------------------------------------------------------------------------
  it("8.6.2: inject 3 degraded measurements (source=ADAPTER) → deriveResourceHealth(A) = DEGRADED", async () => {
    // Backdate the session start so the dwell gate (60s) passes for the switch.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { startedAt: new Date(Date.now() - 120_000) },
    });

    // Inject 3 degraded measurements: very low throughput on resource A.
    // triggerReevaluation=false so the switch only fires when 8.6.4 explicitly
    // calls triggerReevaluation (deterministic test ordering).
    for (let i = 0; i < 3; i++) {
      const res = await ingestMeasurement({
        resourceId: fx.resourceAId,
        sessionId: fx.sessionId,
        providerInstanceId: fx.providerInstanceId,
        type: "QUALITY",
        metrics: { throughputDownMbps: 5, throughputUpMbps: 1, latencyMs: 250, packetLossPercent: 8 },
        source: "ADAPTER",
        confidence: 0.8,
        triggerReevaluation: false,
      });
      expect(res.freshness).toBe("FRESH");
      expect(res.health?.status).toBe(i >= 1 ? "DEGRADED" : "HEALTHY"); // M-of-N kicks in at 2nd degraded sample
    }

    // The persisted health snapshot is DEGRADED
    const health = await getResourceHealth(fx.resourceAId);
    expect(health?.status).toBe("DEGRADED");
    expect(health?.sampleCount).toBe(3);
    expect(health?.degradedCount).toBe(3);
    expect(health?.freshness).toBe("FRESH");
    expect(health?.derivedFromSources).toBe("ADAPTER");

    // A RESOURCE_DEGRADED event was emitted
    const degradedEvent = await db.reevaluationEvent.findFirst({
      where: { resourceId: fx.resourceAId, type: "RESOURCE_DEGRADED" },
    });
    expect(degradedEvent).not.toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 3. Freshness classification
  // -------------------------------------------------------------------------
  it("8.6.3: freshness classification — FRESH / STALE / EXPIRED boundaries", async () => {
    const now = Date.now();
    expect(classifyFreshness(new Date(now - 10_000), now)).toBe("FRESH");
    expect(classifyFreshness(new Date(now - 60_000), now)).toBe("STALE");
    expect(classifyFreshness(new Date(now - 180_000), now)).toBe("EXPIRED");
    expect(classifyFreshness(null, now)).toBe("UNKNOWN");
  }, 10_000);

  // -------------------------------------------------------------------------
  // 4. Re-evaluation → decision = SWITCH B
  // -------------------------------------------------------------------------
  it("8.6.4: triggerReevaluation → makeDecision → SWITCH B (policy ALLOW)", async () => {
    const reeval = await triggerReevaluation(fx.sessionId);
    expect(reeval.decisionAction).toBe("SWITCH");
    expect(reeval.actionExecuted).toBe(true);

    // A ConnectivityDecision with action=SWITCH was persisted
    const decision = await db.connectivityDecision.findFirst({
      where: { sessionId: fx.sessionId, action: "SWITCH" },
      orderBy: { createdAt: "desc" },
    });
    expect(decision).not.toBeNull();
    expect(decision?.targetResourceId).toBe(fx.resourceBId);
    expect(decision?.constraintsSatisfied).toContain("SWITCH_THRESHOLD_MET");
    expect(decision?.constraintsSatisfied).toContain("M_OF_N_DEGRADED");
    expect(decision?.constraintsSatisfied).toContain("HEALTH_FRESH");
  }, 120_000);

  // -------------------------------------------------------------------------
  // 5. SWITCH executed → Session B ACTIVE, A released, invariant holds
  // -------------------------------------------------------------------------
  it("8.6.5: after SWITCH → B IN_USE, A AVAILABLE, invariant holds, Session B ACTIVE", async () => {
    const session = await db.connectivitySession.findUnique({ where: { id: fx.sessionId } });
    expect(session?.state).toBe("ACTIVE");
    expect(session?.activeResourceId).toBe(fx.resourceBId);

    // Resource B is IN_USE, owned by the session
    const resourceB = await db.protocolResource.findUnique({ where: { id: fx.resourceBId } });
    expect(resourceB?.state).toBe("IN_USE");
    expect(resourceB?.reservedBy).toBe(fx.sessionId);

    // Resource A was released back to AVAILABLE
    const resourceA = await db.protocolResource.findUnique({ where: { id: fx.resourceAId } });
    expect(resourceA?.state).toBe("AVAILABLE");
    expect(resourceA?.reservedBy).toBeNull();

    // The invariant holds on the new resource
    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(true);
    expect(invariant.violations).toEqual([]);
    expect(invariant.activeResourceId).toBe(fx.resourceBId);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Freshness gate (DB-backed) — isolated fixture so the post-switch cooldown
// does not interfere with the freshness-gate assertion.
// ---------------------------------------------------------------------------

describe("Phase 8.6 — Freshness gate (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupFixture();
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
  }, 120_000);

  it("8.6.6: STALE health snapshot does NOT trigger auto-switch (freshness gate)", async () => {
    // 1. ACTIVATE A
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.subjectId,
      sessionId: fx.sessionId,
      capabilityType: "INTERNET",
    });
    const action = await createAction({
      sessionId: fx.sessionId,
      decisionId: decision.decisionId,
      type: "ACTIVATE",
      targetResourceId: decision.targetResourceId,
      idempotencyKey: `phase86-freshness-activate-${fx.sessionId}`,
    });
    const execResult = await executeAction(action.id);
    expect(execResult.status).toBe("succeeded");

    // 2. Backdate startedAt so dwell gate passes
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { startedAt: new Date(Date.now() - 120_000) },
    });

    // 3. Inject 2 STALE degraded measurements on A (capturedAt 60s ago → STALE)
    for (let i = 0; i < 2; i++) {
      await ingestMeasurement({
        resourceId: fx.resourceAId,
        sessionId: fx.sessionId,
        providerInstanceId: fx.providerInstanceId,
        type: "QUALITY",
        metrics: { throughputDownMbps: 3, latencyMs: 280, packetLossPercent: 9 },
        source: "ADAPTER",
        confidence: 0.8,
        capturedAt: new Date(Date.now() - 60_000), // STALE
        triggerReevaluation: false,
      });
    }

    // 4. The persisted health is DEGRADED + STALE
    const health = await getResourceHealth(fx.resourceAId);
    expect(health?.status).toBe("DEGRADED");
    expect(health?.freshness).toBe("STALE");
    expect(health?.sampleCount).toBe(2);

    // 5. The decision engine must KEEP (freshness gate), not SWITCH
    const decision2 = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.subjectId,
      sessionId: fx.sessionId,
      capabilityType: "INTERNET",
    });
    expect(decision2.action).toBe("KEEP");
    expect(decision2.constraintsViolated).toContain("STALE_HEALTH");
    expect(decision2.constraintsSatisfied).toContain("FRESHNESS_GATE_ENFORCED");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Recovery from real provider states (DB-backed)
// ---------------------------------------------------------------------------

describe("Phase 8.6 — Recovery from real provider states (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupFixture();
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
  }, 120_000);

  it("8.6.7: crash mid-EXECUTING → recoverStaleActions → reconcile ACTIVE → converge → invariant", async () => {
    // 1. ACTIVATE A normally (succeeds, provider active)
    const decision = await makeDecision({
      tenantId: fx.tenantId,
      subjectId: fx.subjectId,
      sessionId: fx.sessionId,
      capabilityType: "INTERNET",
    });
    const action = await createAction({
      sessionId: fx.sessionId,
      decisionId: decision.decisionId,
      type: "ACTIVATE",
      targetResourceId: decision.targetResourceId,
      idempotencyKey: `phase86-recovery-activate-${fx.sessionId}`,
    });
    const execResult = await executeAction(action.id);
    expect(execResult.status).toBe("succeeded");

    // 2. Simulate a crash: create a SECOND action that is stuck in EXECUTING
    //    with executedAt older than the recovery timeout (5 min).
    const crashedAction = await db.connectivityAction.create({
      data: {
        sessionId: fx.sessionId,
        type: "SWITCH",
        targetResourceId: fx.resourceBId,
        state: "EXECUTING",
        idempotencyKey: `phase86-crashed-${fx.sessionId}-${Date.now()}`,
        executedAt: new Date(Date.now() - 6 * 60_000), // 6 min ago — stale
      },
    });

    // 3. recoverStaleActions claims + recovers the stale action
    const recoveryResult = await recoverStaleActions();
    expect(recoveryResult.recovered).toBeGreaterThan(0);

    // The crashed action is no longer EXECUTING
    const refreshed = await db.connectivityAction.findUnique({ where: { id: crashedAction.id } });
    expect(refreshed?.state).not.toBe("EXECUTING");
    // It either SUCCEEDED (provider reconcile = active) or went to a safe state.
    // For a SWITCH to B (mock adapter active), recovery should converge.
    expect(["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"]).toContain(refreshed?.state);

    // 4. The session converged (still ACTIVE — recovery doesn't break it)
    const session = await db.connectivitySession.findUnique({ where: { id: fx.sessionId } });
    expect(["ACTIVE", "DEGRADED", "SWITCHING"]).toContain(session?.state);

    // 5. If the recovery switched to B, the invariant must hold.
    //    If it stayed on A, the invariant must hold. Either way: invariant valid.
    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(true);
    expect(invariant.violations).toEqual([]);
  }, 120_000);
});
