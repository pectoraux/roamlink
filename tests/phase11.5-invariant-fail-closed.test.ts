/**
 * Phase 11.5 — Runtime Invariant Fail-Closed (DB-backed runtime)
 *
 * Proves acceptance invariant #6:
 *   "Broken session/resource/provider convergence cannot be presented as clean ACTIVE."
 *
 * The prior tests (8.5.10) only statically inspected source strings. This phase
 * proves at RUNTIME that:
 *   1. The invariant checker detects each chain-link corruption.
 *   2. The read model (getCurrentConnectivityForUser) does NOT present the
 *      session as clean ACTIVE when the invariant fails.
 *   3. The read model surfaces the divergence as RECONCILIATION_REQUIRED.
 *
 * Tests:
 *   11.5.1: resource.reservedBy corrupted → invariant detects, read model shows divergence
 *   11.5.2: resource.state not IN_USE → invariant detects, read model shows divergence
 *   11.5.3: resource.providerBindingId null → invariant detects, read model shows divergence
 *   11.5.4: binding.entitlement.userId mismatch → invariant detects, read model shows divergence
 *   11.5.5: session.entitlementId mismatch → invariant detects, read model shows divergence
 *   11.5.6: control (no corruption) → invariant passes, read model shows clean ACTIVE
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase11.5-invariant-fail-closed.test.ts
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
import { assertActiveConnectivityInvariant } from "@/lib/control-plane/invariant-checker";
import { getCurrentConnectivityForUser } from "@/lib/control-plane/current-connectivity";
import { clearProviderTruthOverride } from "@/lib/control-plane/kernel-bridge";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  subjectId: string;
  resourceAId: string;
  resourceBId: string;
  entitlementId: string;
  bindingAId: string;
  providerInstanceId: string;
  sessionId: string;
  capabilityAId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase115-${Date.now()}@test.roamlink`;
  const slug = `p115-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P11.5 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P115 ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P115 ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });

  const entInput: ConnectivityEntitlementInput = {
    id: ent.id, tenantId: tenant.id, subscriptionId: subscription.id, status: "ACTIVE",
    capabilityType: "INTERNET", capabilitySet: JSON.parse(ent.capabilitySet),
    policy: null, validFrom: ent.validFrom, validUntil: null,
  };
  const prA = await mockConnectivityProvider.provision({ entitlement: entInput, binding: { id: "b", entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null } as ProviderResourceBindingInput });
  const bA = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prA.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resA.id }, data: { providerBindingId: bA.id } });

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: ent.id });

  // ACTIVATE resource A so the session is ACTIVE on A.
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id, capabilityType: "INTERNET" });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p115-${session.id}` });
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
    await db.resourceHealth.deleteMany({ where: { resourceId: resA.id } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: resA.id } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: capA.id } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: bA.id } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { tenantId: tenant.id, subjectId, resourceAId: resA.id, resourceBId: "", entitlementId: ent.id, bindingAId: bA.id, providerInstanceId: pi.id, sessionId: session.id, capabilityAId: capA.id, cleanup };
}

// ---------------------------------------------------------------------------
// Helper: snapshot the resource state for restoration
// ---------------------------------------------------------------------------

type ResourceSnapshot = {
  state: string;
  reservedBy: string | null;
  providerBindingId: string | null;
};

type BindingSnapshot = {
  status: string;
  entitlementId: string | null;
};

type SessionSnapshot = {
  state: string;
  entitlementId: string | null;
};

async function snapshotState(fx: Fixture): Promise<{
  resource: ResourceSnapshot;
  binding: BindingSnapshot | null;
  session: SessionSnapshot;
}> {
  const resource = await db.protocolResource.findUnique({
    where: { id: fx.resourceAId },
    select: { state: true, reservedBy: true, providerBindingId: true },
  });
  const binding = fx.bindingAId ? await db.providerResourceBinding.findUnique({
    where: { id: fx.bindingAId },
    select: { status: true, entitlementId: true },
  }) : null;
  const session = await db.connectivitySession.findUnique({
    where: { id: fx.sessionId },
    select: { state: true, entitlementId: true },
  });
  return {
    resource: { state: resource?.state ?? "AVAILABLE", reservedBy: resource?.reservedBy ?? null, providerBindingId: resource?.providerBindingId ?? null },
    binding: binding ? { status: binding.status, entitlementId: binding.entitlementId } : null,
    session: { state: session?.state ?? "PLANNED", entitlementId: session?.entitlementId ?? null },
  };
}

async function restoreState(fx: Fixture, snap: { resource: ResourceSnapshot; binding: BindingSnapshot | null; session: SessionSnapshot }) {
  await db.protocolResource.update({
    where: { id: fx.resourceAId },
    data: { state: snap.resource.state, reservedBy: snap.resource.reservedBy, providerBindingId: snap.resource.providerBindingId },
  }).catch(() => {});
  if (fx.bindingAId && snap.binding) {
    await db.providerResourceBinding.update({
      where: { id: fx.bindingAId },
      data: { status: snap.binding.status, entitlementId: snap.binding.entitlementId },
    }).catch(() => {});
  }
  await db.connectivitySession.update({
    where: { id: fx.sessionId },
    data: { state: snap.session.state, entitlementId: snap.session.entitlementId },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 11.5 — Runtime Invariant Fail-Closed (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 180_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);
  afterEach(() => { clearProviderTruthOverride(); });

  // =========================================================================
  // 11.5.6 — Control: no corruption → invariant passes, read model shows ACTIVE
  // =========================================================================
  it("11.5.6: control (no corruption) → invariant passes, read model shows clean ACTIVE", async () => {
    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(true);
    expect(invariant.violations).toHaveLength(0);

    const current = await getCurrentConnectivityForUser(fx.subjectId);
    expect(current.session).not.toBeNull();
    expect(current.session?.state).toBe("ACTIVE");
    // The read model should NOT flag a reconciliation state.
    expect(current.session?.state).not.toBe("RECONCILIATION_REQUIRED");
  }, 60_000);

  // =========================================================================
  // 11.5.1 — resource.reservedBy corrupted → invariant detects, read model shows divergence
  // =========================================================================
  it("11.5.1: resource.reservedBy corrupted → invariant detects, read model shows RECONCILIATION_REQUIRED", async () => {
    const snap = await snapshotState(fx);

    // Corrupt: resource A's reservedBy points to a different session.
    await db.protocolResource.update({
      where: { id: fx.resourceAId },
      data: { reservedBy: "another-session-id" },
    });

    // 1. The invariant checker MUST detect the divergence.
    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(false);
    expect(invariant.violations.some((v) => v.includes("reservedBy"))).toBe(true);

    // 2. The read model MUST NOT present the session as clean ACTIVE.
    const current = await getCurrentConnectivityForUser(fx.subjectId);
    expect(current.session).not.toBeNull();
    // The session state is ACTIVE in the DB, but the read model should
    // surface the invariant violation as RECONCILIATION_REQUIRED.
    expect(current.session?.state).toBe("RECONCILIATION_REQUIRED");

    // Restore.
    await restoreState(fx, snap);
  }, 60_000);

  // =========================================================================
  // 11.5.2 — resource.state not IN_USE → invariant detects, read model shows divergence
  // =========================================================================
  it("11.5.2: resource.state not IN_USE → invariant detects, read model shows RECONCILIATION_REQUIRED", async () => {
    const snap = await snapshotState(fx);

    // Corrupt: resource A's state is AVAILABLE (not IN_USE).
    await db.protocolResource.update({
      where: { id: fx.resourceAId },
      data: { state: "AVAILABLE" },
    });

    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(false);
    expect(invariant.violations.some((v) => v.includes("IN_USE"))).toBe(true);

    const current = await getCurrentConnectivityForUser(fx.subjectId);
    expect(current.session).not.toBeNull();
    expect(current.session?.state).toBe("RECONCILIATION_REQUIRED");

    await restoreState(fx, snap);
  }, 60_000);

  // =========================================================================
  // 11.5.3 — resource.providerBindingId null → invariant detects, read model shows divergence
  // =========================================================================
  it("11.5.3: resource.providerBindingId null → invariant detects, read model shows RECONCILIATION_REQUIRED", async () => {
    const snap = await snapshotState(fx);

    // Corrupt: resource A's providerBindingId is null.
    await db.protocolResource.update({
      where: { id: fx.resourceAId },
      data: { providerBindingId: null },
    });

    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(false);
    expect(invariant.violations.some((v) => v.includes("providerBindingId"))).toBe(true);

    const current = await getCurrentConnectivityForUser(fx.subjectId);
    expect(current.session).not.toBeNull();
    expect(current.session?.state).toBe("RECONCILIATION_REQUIRED");

    await restoreState(fx, snap);
  }, 60_000);

  // =========================================================================
  // 11.5.4 — binding.entitlement.userId mismatch → invariant detects, read model shows divergence
  // =========================================================================
  it("11.5.4: binding.entitlement.userId mismatch → invariant detects, read model shows RECONCILIATION_REQUIRED", async () => {
    const snap = await snapshotState(fx);

    // Corrupt: the binding's entitlement is linked to a different user.
    // We need a different entitlement to link to. Create a temp one with the
    // correct tenant + subscription + capability (the global ConnectivityCapability,
    // not the tenant-scoped ProtocolCapability).
    const origEnt = await db.connectivityEntitlement.findUnique({ where: { id: fx.entitlementId } });
    const tempEnt = await db.connectivityEntitlement.create({
      data: {
        tenantId: fx.tenantId,
        subscriptionId: origEnt!.subscriptionId,
        capabilityId: origEnt!.capabilityId, // use the same global capability
        status: "ACTIVE",
        capabilitySet: JSON.stringify({ downloadMbps: 100 }),
        validFrom: new Date(),
        userId: "different-user-id",
      },
    });
    await db.providerResourceBinding.update({
      where: { id: fx.bindingAId },
      data: { entitlementId: tempEnt.id },
    });

    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(false);
    expect(invariant.violations.some((v) => v.includes("userId"))).toBe(true);

    const current = await getCurrentConnectivityForUser(fx.subjectId);
    expect(current.session).not.toBeNull();
    expect(current.session?.state).toBe("RECONCILIATION_REQUIRED");

    // Restore + cleanup temp entitlement.
    await restoreState(fx, snap);
    await db.connectivityEntitlement.delete({ where: { id: tempEnt.id } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 11.5.5 — session.entitlementId mismatch → invariant detects, read model shows divergence
  // =========================================================================
  it("11.5.5: session.entitlementId mismatch → invariant detects, read model shows RECONCILIATION_REQUIRED", async () => {
    const snap = await snapshotState(fx);

    // Corrupt: session's entitlementId points to a different entitlement.
    await db.connectivitySession.update({
      where: { id: fx.sessionId },
      data: { entitlementId: "different-entitlement-id" },
    });

    const invariant = await assertActiveConnectivityInvariant(fx.sessionId);
    expect(invariant.valid).toBe(false);
    expect(invariant.violations.some((v) => v.includes("entitlementId"))).toBe(true);

    const current = await getCurrentConnectivityForUser(fx.subjectId);
    expect(current.session).not.toBeNull();
    expect(current.session?.state).toBe("RECONCILIATION_REQUIRED");

    await restoreState(fx, snap);
  }, 60_000);
});
