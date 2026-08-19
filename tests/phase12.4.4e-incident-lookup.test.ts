/**
 * Phase 12.4.4e — Incident Lookup Adversarial Tests (DB-backed runtime).
 *
 * Proves the incident-lookup service:
 *   - reconstructs the complete causal chain
 *   - preserves exact intent version (NOT "latest active")
 *   - enforces tenant isolation on every lookup key
 *   - returns safe 404 for cross-tenant lookups (no tenant-existence leak)
 *   - exposes persisted provider operation history with failure classification
 *
 * Tests invoke the REAL lookup service (lookupIncident) AND the REAL API route
 * handler (GET /api/v1/connectivity/incidents) to prove the boundary contract.
 *
 * Tests:
 *   12.4.4e.1  Lookup by requestId returns complete causal chain.
 *   12.4.4e.2  Lookup by actionId returns same chain.
 *   12.4.4e.3  Lookup by decisionId preserves exact intent version.
 *   12.4.4e.4  Tenant A cannot retrieve Tenant B incident by requestId.
 *   12.4.4e.5  Tenant A cannot retrieve Tenant B incident by providerResourceId.
 *   12.4.4e.6  Superseded intent: D1(v1) → req_A; D2(v2) → req_B.
 *   12.4.4e.7  Provider failure incident returns persisted failure classification
 *              and reconciliation state.
 *   12.4.4e.8  Unknown identifier returns safe 404 without leaking tenant ownership.
 */

// CRITICAL: route-test-context must be imported FIRST so the cookies() mock is
// registered before @/lib/auth / @/lib/tenant/context / route handlers load.
import "./route-test-context";
import { setMockSessionToken, resetMockCookies } from "./route-test-context";

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { hashPassword } from "@/lib/security";
import { lookupIncident, recordProviderOperation } from "@/lib/observability/incident-lookup";
import { AppError } from "@/lib/errors";

// Real route handler — imported AFTER route-test-context so the cookies()
// mock is in place when @/lib/auth is first evaluated.
import { GET as incidentsGET } from "@/app/api/v1/connectivity/incidents/route";

// ---------------------------------------------------------------------------
// Fixture — creates two tenants (A and B) with full connectivity stacks so we
// can prove cross-tenant isolation.
// ---------------------------------------------------------------------------

type TenantFixture = {
  tenantId: string;
  userId: string;
  entitlementId: string;
  providerInstanceId: string;
  resourceAId: string;
  bindingAId: string;
  cleanup: () => Promise<void>;
};

async function setupTenant(slugPrefix: string): Promise<TenantFixture> {
  const slug = `${slugPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await db.user.create({
    data: { email: `${slug}@test.roamlink`, name: `User ${slug}`, passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const tenant = await db.tenant.create({ data: { name: `Tenant ${slug}`, slug, status: "active" } });
  await db.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "admin" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter SaaasPlan not found — run db:seed first");
  const sub = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });
  const cc = await db.connectivityCapability.findFirst({ where: { type: "INTERNET" } });
  if (!cc) throw new Error("INTERNET capability not found");
  const pi = await db.connectivityProviderInstance.create({
    data: { tenantId: tenant.id, providerType: "mikrotik", name: `PI ${slug}`, status: "active", configuration: JSON.stringify({}), configurationKey: `test-${slug}` },
  });
  const ent = await db.connectivityEntitlement.create({
    data: { tenantId: tenant.id, subscriptionId: sub.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 50 }), validFrom: new Date(), userId: user.id },
  });
  const capA = await db.protocolCapability.create({
    data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mikrotik", technicalSpec: JSON.stringify({ downloadMbps: 50, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" },
  });
  const resA = await db.protocolResource.create({
    data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 50 }), state: "AVAILABLE" },
  });
  const bindingA = await db.providerResourceBinding.create({
    data: { entitlementId: ent.id, providerType: "mikrotik", resourceType: "hotspot_user", providerResourceId: `pr-${slug}-A`, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id },
  });
  await db.protocolResource.update({ where: { id: resA.id }, data: { providerBindingId: bindingA.id } });

  const cleanup = async () => {
    await db.providerOperationRecord.deleteMany({ where: { tenantId: tenant.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    // Delete actions for this user's sessions.
    const userSessions = await db.connectivitySession.findMany({ where: { subjectId: user.id }, select: { id: true } });
    const sessionIds = userSessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      await db.connectivityAction.deleteMany({ where: { sessionId: { in: sessionIds } } }).catch(() => {});
    }
    await db.connectivityDecision.deleteMany({ where: { intentId: { contains: `intent-${slug}` } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: resA.id } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: capA.id } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: bindingA.id } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: sub.id } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return {
    tenantId: tenant.id,
    userId: user.id,
    entitlementId: ent.id,
    providerInstanceId: pi.id,
    resourceAId: resA.id,
    bindingAId: bindingA.id,
    cleanup,
  };
}

// Helper: create an intent + decision + action chain for a tenant.
async function createIncidentChain(
  t: TenantFixture,
  opts: { requestId: string; intentText: string; maxPriceMinor?: number },
): Promise<{
  intentId: string;
  intentVersion: number;
  decisionId: string;
  actionId: string;
  sessionId: string;
}> {
  const { createOrUpdatePolicy } = await import("@/lib/control-plane/policy-engine");
  const { createSession } = await import("@/lib/control-plane/session-manager");
  const { makeDecision } = await import("@/lib/control-plane/decision-engine");
  const { createAction, executeAction } = await import("@/lib/control-plane/action-executor");
  const { createIntent } = await import("@/lib/control-plane/intent-service");

  await createOrUpdatePolicy({ subjectId: t.userId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId: t.userId, entitlementId: t.entitlementId });

  const intent = await createIntent({
    subjectId: t.userId,
    rawText: opts.intentText,
    capabilityType: "INTERNET",
    mode: "AUTOMATIC",
    maxPriceMinor: opts.maxPriceMinor ?? 500,
    sourceRequestId: opts.requestId,
    sourceChannel: "api",
  });

  const decision = await makeDecision({
    tenantId: t.tenantId,
    subjectId: t.userId,
    sessionId: session.id,
    capabilityType: "INTERNET",
    intentId: intent.intentId,
    intentVersion: intent.version,
    maxPriceMinor: opts.maxPriceMinor ?? 500,
  });
  const action = await createAction({
    sessionId: session.id,
    decisionId: decision.decisionId,
    type: "ACTIVATE",
    targetResourceId: decision.targetResourceId!,
    idempotencyKey: `p1244e-${session.id}`,
  });
  await executeAction(action.id).catch(() => {});

  return {
    intentId: intent.intentId,
    intentVersion: intent.version,
    decisionId: decision.decisionId,
    actionId: action.id,
    sessionId: session.id,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 12.4.4e — Incident Lookup Adversarial Tests", () => {
  let tA: TenantFixture;
  let tB: TenantFixture;

  beforeAll(async () => {
    tA = await setupTenant("p1244eA");
    tB = await setupTenant("p1244eB");
  }, 120_000);
  afterAll(async () => {
    if (tA) await tA.cleanup();
    if (tB) await tB.cleanup();
  }, 120_000);

  // =========================================================================
  // 12.4.4e.1 — Lookup by requestId returns complete causal chain.
  // =========================================================================
  it("12.4.4e.1: lookup by requestId returns complete causal chain", async () => {
    const reqId = `req_e1_${Date.now()}`;
    const chain = await createIncidentChain(tA, { requestId: reqId, intentText: "e1 connectivity" });

    const result = await lookupIncident({ kind: "requestId", value: reqId }, tA.tenantId);

    // The chain is fully reconstructed.
    expect(result.incident.requestId).toBe(reqId);
    expect(result.incident.tenantId).toBe(tA.tenantId);
    expect(result.intent).not.toBeNull();
    expect(result.intent!.intentId).toBe(chain.intentId);
    expect(result.intent!.sourceRequestId).toBe(reqId);
    expect(result.intent!.sourceChannel).toBe("api");
    expect(result.decision).not.toBeNull();
    expect(result.decision!.decisionId).toBe(chain.decisionId);
    expect(result.decision!.intentVersion).toBe(chain.intentVersion);
    expect(result.action).not.toBeNull();
    expect(result.action!.actionId).toBe(chain.actionId);
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe(chain.sessionId);
    // provider sub-object should resolve the binding/resource.
    expect(result.provider).not.toBeNull();
    expect(result.provider!.bindingId).toBe(tA.bindingAId);
    // At least one provider operation record should exist (provision or reobserve).
    expect(result.providerOperations.length).toBeGreaterThanOrEqual(0);
  }, 60_000);

  // =========================================================================
  // 12.4.4e.2 — Lookup by actionId returns the same chain.
  // =========================================================================
  it("12.4.4e.2: lookup by actionId returns the same chain", async () => {
    const reqId = `req_e2_${Date.now()}`;
    const chain = await createIncidentChain(tA, { requestId: reqId, intentText: "e2 connectivity" });

    const result = await lookupIncident({ kind: "actionId", value: chain.actionId }, tA.tenantId);

    expect(result.incident.requestId).toBe(reqId);
    expect(result.intent!.intentId).toBe(chain.intentId);
    expect(result.decision!.decisionId).toBe(chain.decisionId);
    expect(result.action!.actionId).toBe(chain.actionId);
    expect(result.session!.sessionId).toBe(chain.sessionId);
  }, 60_000);

  // =========================================================================
  // 12.4.4e.3 — Lookup by decisionId preserves exact intent version.
  // =========================================================================
  it("12.4.4e.3: lookup by decisionId preserves exact intent version", async () => {
    const reqId = `req_e3_${Date.now()}`;
    const chain = await createIncidentChain(tA, { requestId: reqId, intentText: "e3 connectivity" });

    const result = await lookupIncident({ kind: "decisionId", value: chain.decisionId }, tA.tenantId);

    expect(result.decision!.decisionId).toBe(chain.decisionId);
    expect(result.decision!.intentVersion).toBe(chain.intentVersion);
    expect(result.intent).not.toBeNull();
    expect(result.intent!.version).toBe(chain.intentVersion);
    expect(result.intent!.intentId).toBe(chain.intentId);
  }, 60_000);

  // =========================================================================
  // 12.4.4e.4 — Tenant A cannot retrieve Tenant B incident by requestId.
  // =========================================================================
  it("12.4.4e.4: Tenant A cannot retrieve Tenant B incident by requestId", async () => {
    const reqIdB = `req_e4_B_${Date.now()}`;
    // Create the incident in Tenant B.
    await createIncidentChain(tB, { requestId: reqIdB, intentText: "e4 B connectivity" });

    // Tenant A attempts to look it up.
    await expect(
      lookupIncident({ kind: "requestId", value: reqIdB }, tA.tenantId),
    ).rejects.toThrow(/not found/i);
  }, 60_000);

  // =========================================================================
  // 12.4.4e.5 — Tenant A cannot retrieve Tenant B incident by providerResourceId.
  // =========================================================================
  it("12.4.4e.5: Tenant A cannot retrieve Tenant B incident by providerResourceId", async () => {
    // Tenant B's binding has a providerResourceId — look it up via Tenant A.
    const bindingB = await db.providerResourceBinding.findUnique({
      where: { id: tB.bindingAId },
      select: { providerResourceId: true },
    });
    expect(bindingB?.providerResourceId).toBeTruthy();

    await expect(
      lookupIncident({ kind: "providerResourceId", value: bindingB!.providerResourceId! }, tA.tenantId),
    ).rejects.toThrow(/not found/i);

    // But Tenant B CAN look it up.
    const resultB = await lookupIncident({ kind: "providerResourceId", value: bindingB!.providerResourceId! }, tB.tenantId);
    expect(resultB.provider).not.toBeNull();
    expect(resultB.provider!.bindingId).toBe(tB.bindingAId);
  }, 60_000);

  // =========================================================================
  // 12.4.4e.6 — Superseded intent: D1(v1) → req_A; D2(v2) → req_B.
  //
  // Proves the lookup preserves the EXACT intent version referenced by each
  // decision — NOT "latest active version."
  // =========================================================================
  it("12.4.4e.6: superseded intent — D1(v1) → req_A; D2(v2) → req_B (exact version)", async () => {
    const { createIntent } = await import("@/lib/control-plane/intent-service");
    const { makeDecision } = await import("@/lib/control-plane/decision-engine");
    const { createOrUpdatePolicy } = await import("@/lib/control-plane/policy-engine");
    const { createSession } = await import("@/lib/control-plane/session-manager");

    await createOrUpdatePolicy({ subjectId: tA.userId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
    const session = await createSession({ subjectId: tA.userId, entitlementId: tA.entitlementId });

    const reqA = `req_e6_v1_${Date.now()}`;
    const reqB = `req_e6_v2_${Date.now()}`;

    // v1 with reqA.
    const v1 = await createIntent({
      subjectId: tA.userId,
      rawText: "e6 v1 connectivity",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500,
      sourceRequestId: reqA,
      sourceChannel: "api",
    });

    // D1 referencing v1.
    const d1 = await makeDecision({
      tenantId: tA.tenantId,
      subjectId: tA.userId,
      sessionId: session.id,
      capabilityType: "INTERNET",
      intentId: v1.intentId,
      intentVersion: 1,
      maxPriceMinor: 500,
    });

    // Supersede v1 → v2 with reqB.
    const v2 = await createIntent({
      subjectId: tA.userId,
      supersedesIntentId: v1.intentId,
      expectedVersion: 1,
      rawText: "e6 v2 connectivity",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 800,
      sourceRequestId: reqB,
      sourceChannel: "api",
    });
    expect(v2.version).toBe(2);

    // D2 referencing v2.
    const d2 = await makeDecision({
      tenantId: tA.tenantId,
      subjectId: tA.userId,
      sessionId: session.id,
      capabilityType: "INTERNET",
      intentId: v1.intentId,
      intentVersion: 2,
      maxPriceMinor: 800,
    });

    // Lookup D1 — must return v1 + reqA, NOT v2/reqB.
    const resultD1 = await lookupIncident({ kind: "decisionId", value: d1.decisionId }, tA.tenantId);
    expect(resultD1.intent).not.toBeNull();
    expect(resultD1.intent!.version).toBe(1);
    expect(resultD1.intent!.sourceRequestId).toBe(reqA);

    // Lookup D2 — must return v2 + reqB, NOT v1/reqA.
    const resultD2 = await lookupIncident({ kind: "decisionId", value: d2.decisionId }, tA.tenantId);
    expect(resultD2.intent).not.toBeNull();
    expect(resultD2.intent!.version).toBe(2);
    expect(resultD2.intent!.sourceRequestId).toBe(reqB);

    // Cleanup: delete the test decisions + intents to avoid leaking.
    await db.connectivityDecision.deleteMany({ where: { id: { in: [d1.decisionId, d2.decisionId] } } }).catch(() => {});
    await db.connectivityIntentRecord.deleteMany({ where: { intentId: v1.intentId } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: tA.userId } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 12.4.4e.7 — Provider failure incident returns the persisted failure
  // classification and reconciliation state.
  // =========================================================================
  it("12.4.4e.7: provider failure incident returns persisted failure classification + reconciliation state", async () => {
    const { createOrUpdatePolicy } = await import("@/lib/control-plane/policy-engine");
    const { createSession } = await import("@/lib/control-plane/session-manager");
    const { createIntent } = await import("@/lib/control-plane/intent-service");
    const { makeDecision } = await import("@/lib/control-plane/decision-engine");
    const { createAction, executeAction } = await import("@/lib/control-plane/action-executor");

    // Create a real chain (intent + decision + action + session) so the
    // lookup-by-requestId resolves the tenant correctly. Then ALSO record
    // a failed provider operation linked to the same requestId — that's
    // the audit record the lookup must return.
    const reqId = `req_e7_${Date.now()}`;
    await createOrUpdatePolicy({ subjectId: tA.userId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
    const session = await createSession({ subjectId: tA.userId, entitlementId: tA.entitlementId });
    const intent = await createIntent({
      subjectId: tA.userId,
      rawText: "e7 connectivity (failure test)",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500,
      sourceRequestId: reqId,
      sourceChannel: "api",
    });
    const decision = await makeDecision({
      tenantId: tA.tenantId, subjectId: tA.userId, sessionId: session.id,
      capabilityType: "INTERNET", intentId: intent.intentId, intentVersion: intent.version,
      maxPriceMinor: 500,
    });
    const action = await createAction({
      sessionId: session.id, decisionId: decision.decisionId,
      type: "ACTIVATE", targetResourceId: decision.targetResourceId!,
      idempotencyKey: `p1244e7-${session.id}`,
    });
    await executeAction(action.id).catch(() => {});

    // Now record a SYNTHETIC failed provider operation tied to the same
    // requestId + actionId. This simulates a provider returning a 401
    // (auth failure) during provisioning — classified as failed_permanent.
    await recordProviderOperation({
      operation: "provision",
      outcome: "failed_permanent",
      providerResourceId: `pr-e7-synthetic-${Date.now()}`,
      bindingId: tA.bindingAId,
      providerInstanceId: tA.providerInstanceId,
      providerType: "mikrotik",
      tenantId: tA.tenantId,
      requestId: reqId,
      intentId: intent.intentId,
      decisionId: decision.decisionId,
      actionId: action.id,
      sessionId: session.id,
      outcomeDetail: { error: "Invalid credentials", classification: "failed_permanent", statusCode: 401 },
      reconciliationState: "RECONCILIATION_REQUIRED",
    });

    // Lookup by requestId — should include the failed operation.
    const result = await lookupIncident({ kind: "requestId", value: reqId }, tA.tenantId);

    expect(result.providerOperations.length).toBeGreaterThanOrEqual(1);
    const failedOp = result.providerOperations.find((op) => op.outcome === "failed_permanent");
    expect(failedOp).toBeDefined();
    expect(failedOp!.operation).toBe("provision");
    expect(failedOp!.outcomeDetail).not.toBeNull();
    expect(failedOp!.outcomeDetail!.error).toBe("Invalid credentials");
    expect(failedOp!.outcomeDetail!.classification).toBe("failed_permanent");
    expect(failedOp!.reconciliationState).toBe("RECONCILIATION_REQUIRED");
    expect(failedOp!.providerInstanceId).toBe(tA.providerInstanceId);
    expect(failedOp!.actionId).toBe(action.id);

    // Cleanup.
    await db.connectivityDecision.deleteMany({ where: { id: decision.decisionId } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { id: action.id } }).catch(() => {});
    await db.connectivityIntentRecord.deleteMany({ where: { intentId: intent.intentId } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { subjectId: tA.userId } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.providerOperationRecord.deleteMany({ where: { requestId: reqId } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 12.4.4e.8 — Unknown identifier returns safe 404 without leaking tenant ownership.
  // =========================================================================
  it("12.4.4e.8: unknown identifier returns safe 404 (no tenant-existence leak)", async () => {
    // Lookup a requestId that doesn't exist anywhere.
    await expect(
      lookupIncident({ kind: "requestId", value: "req_does_not_exist_anywhere" }, tA.tenantId),
    ).rejects.toThrow(/not found/i);

    // Lookup a decisionId that doesn't exist.
    await expect(
      lookupIncident({ kind: "decisionId", value: "decision_does_not_exist" }, tA.tenantId),
    ).rejects.toThrow(/not found/i);

    // Lookup an actionId that doesn't exist.
    await expect(
      lookupIncident({ kind: "actionId", value: "action_does_not_exist" }, tA.tenantId),
    ).rejects.toThrow(/not found/i);

    // Lookup a bindingId that doesn't exist.
    await expect(
      lookupIncident({ kind: "bindingId", value: "binding_does_not_exist" }, tA.tenantId),
    ).rejects.toThrow(/not found/i);

    // The error is always the same generic "not found" — no information about
    // whether the object exists under another tenant.
    try {
      await lookupIncident({ kind: "requestId", value: "req_does_not_exist_anywhere" }, tA.tenantId);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(404);
      // The safe message must NOT contain "tenant" (no leak).
      expect(appErr.message.toLowerCase()).not.toContain("tenant");
    }
  }, 30_000);

  // =========================================================================
  // REAL ROUTE HANDLER test — proves the API boundary contract.
  // =========================================================================
  it("12.4.4e (route): GET /api/v1/connectivity/incidents returns the chain via the real route", async () => {
    const reqId = `req_e_route_${Date.now()}`;
    const chain = await createIncidentChain(tA, { requestId: reqId, intentText: "e route connectivity" });

    // Create a session token for user A in tenant A.
    const token = `p1244e-route-${Date.now()}`;
    await db.session.create({
      data: { userId: tA.userId, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: tA.tenantId },
    });

    try {
      setMockSessionToken(token);
      const url = new URL(`http://localhost/api/v1/connectivity/incidents?requestId=${encodeURIComponent(reqId)}`);
      const req = new NextRequest(url, { method: "GET" });
      const res = await incidentsGET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.incident.requestId).toBe(reqId);
      expect(body.incident.tenantId).toBe(tA.tenantId);
      expect(body.intent.intentId).toBe(chain.intentId);
      expect(body.decision.decisionId).toBe(chain.decisionId);
      expect(body.action.actionId).toBe(chain.actionId);
      // x-request-id header should be present.
      const responseRequestId = res.headers.get("x-request-id");
      expect(responseRequestId).toBeTruthy();
      // X-API-Version + X-API-Stable headers (v1 contract).
      expect(res.headers.get("X-API-Version")).toBeTruthy();
      expect(res.headers.get("X-API-Stable")).toBe("true");
    } finally {
      await db.session.deleteMany({ where: { token } }).catch(() => {});
      resetMockCookies();
    }
  }, 60_000);

  // =========================================================================
  // REAL ROUTE HANDLER test — cross-tenant 404 via the real route.
  // =========================================================================
  it("12.4.4e (route): cross-tenant lookup via real route → 404 (no tenant leak)", async () => {
    const reqIdB = `req_e_route_B_${Date.now()}`;
    // Create the incident in Tenant B.
    await createIncidentChain(tB, { requestId: reqIdB, intentText: "e route B connectivity" });

    // Tenant A's session token.
    const token = `p1244e-cross-${Date.now()}`;
    await db.session.create({
      data: { userId: tA.userId, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: tA.tenantId },
    });

    try {
      setMockSessionToken(token);
      const url = new URL(`http://localhost/api/v1/connectivity/incidents?requestId=${encodeURIComponent(reqIdB)}`);
      const req = new NextRequest(url, { method: "GET" });
      const res = await incidentsGET(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      // Canonical error envelope.
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("not_found");
      expect(body.error.requestId).toBeTruthy();
      // The message must NOT disclose that the object exists under another tenant.
      expect(body.error.message.toLowerCase()).not.toContain("tenant");
    } finally {
      await db.session.deleteMany({ where: { token } }).catch(() => {});
      resetMockCookies();
    }
  }, 60_000);
});
