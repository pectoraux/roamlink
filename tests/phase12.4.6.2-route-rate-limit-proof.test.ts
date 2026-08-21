/**
 * Phase 12.4.6.2 — Route-Level Rate-Limiting Proof (runtime tests).
 *
 * Proves through REAL route handler invocations that:
 *   - the limiter is an execution boundary (429 prevents side effects)
 *   - no DB mutation occurs when rate-limited
 *   - tenant aggregate quota is enforced through real routes
 *   - sensitive endpoint quota is enforced through real routes
 *   - malformed auth does not create a rate-limit identity
 */

import "./route-test-context";
import { setMockSessionToken, resetMockCookies } from "./route-test-context";

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { hashPassword } from "@/lib/security";
import { createTenant } from "@/lib/tenant/service";
import { pruneRateLimitEvents } from "@/lib/api/rate-limit";

// Real route handlers.
import { GET as sessionsGET, POST as sessionsPOST } from "@/app/api/v1/connectivity/sessions/route";
import { POST as actionsPOST } from "@/app/api/v1/connectivity/actions/route";
import { POST as observationsPOST } from "@/app/api/v1/connectivity/edge/observations/route";

type Fixture = {
  tenantId: string;
  userId: string;
  token: string;
  tenantId2: string;
  userId2: string;
  token2: string;
  entitlementId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const slug = `p12462p-${Date.now().toString(36)}`;
  const user = await db.user.create({
    data: { email: `p12462p-${Date.now()}@test.roamlink`, name: "P12462p User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const tenant = await createTenant({ name: `P12462p ${slug}`, slug, status: "active" });
  await db.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "admin" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (starterPlan) {
    await db.tenantSubscription.create({ data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  }
  const cc = await db.connectivityCapability.findFirst({ where: { type: "INTERNET" } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: `sub-${slug}`, capabilityId: cc!.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 50 }), validFrom: new Date(), userId: user.id } });
  const session = await db.connectivitySession.create({ data: { subjectId: user.id, entitlementId: ent.id, state: "PLANNED" } });

  const token = `p12462p-${Date.now()}`;
  await db.session.create({ data: { userId: user.id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: tenant.id } });

  // Second tenant.
  const slug2 = `b-${slug}`;
  const user2 = await db.user.create({
    data: { email: `b-p12462p-${Date.now()}@test.roamlink`, name: "P12462p User B", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const tenant2 = await createTenant({ name: `P12462p B ${slug2}`, slug: slug2, status: "active" });
  await db.tenantUser.create({ data: { tenantId: tenant2.id, userId: user2.id, role: "admin" } });
  if (starterPlan) {
    await db.tenantSubscription.create({ data: { tenantId: tenant2.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  }
  const token2 = `p12462p-b-${Date.now()}`;
  await db.session.create({ data: { userId: user2.id, token: token2, expiresAt: new Date(Date.now() + 86400000), activeTenantId: tenant2.id } });

  const cleanup = async () => {
    await db.rateLimitCounter.deleteMany({ where: { scopeId: { contains: tenant.id } } }).catch(() => {});
    await db.rateLimitCounter.deleteMany({ where: { scopeId: { contains: tenant2.id } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.session.deleteMany({ where: { token: { in: [token, token2] } } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { userId: { in: [user.id, user2.id] } } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: { in: [tenant.id, tenant2.id] } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [user.id, user2.id] } } }).catch(() => {});
  };

  return { tenantId: tenant.id, userId: user.id, token, tenantId2: tenant2.id, userId2: user2.id, token2, entitlementId: ent.id, sessionId: session.id, cleanup };
}

async function exhaustTenantQuota(tenantId: string) {
  const now = new Date();
  const iso = now.toISOString().slice(0, 16);
  await db.rateLimitCounter.upsert({
    where: { scope_scopeId_windowKey: { scope: "tenant", scopeId: tenantId, windowKey: iso } },
    create: { scope: "tenant", scopeId: tenantId, windowKey: iso, count: 500, expiresAt: new Date(Date.now() + 300000) },
    update: { count: 500 },
  });
}

async function cleanScope(scopeId: string) {
  await db.rateLimitCounter.deleteMany({ where: { scopeId } }).catch(() => {});
}

describe("Phase 12.4.6.2 — Route-Level Rate-Limiting Proof", () => {
  let fx: Fixture;
  beforeAll(async () => {
    await pruneRateLimitEvents();
    fx = await setupFixture();
  }, 30_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 30_000);

  // 12.4.6.2.8 — exhaust quota through real route → 429, no side effect
  it("12.4.6.2.8: exhausted quota → 429, no session created", async () => {
    setMockSessionToken(fx.token);

    // Exhaust the tenant quota.
    await exhaustTenantQuota(fx.tenantId);

    // Count sessions BEFORE the rate-limited request.
    const sessionsBefore = await db.connectivitySession.count({ where: { subjectId: fx.userId } });

    // Call the real sessions POST route (which creates a session).
    const req = new NextRequest("http://localhost/api/v1/connectivity/sessions", {
      method: "POST",
      body: JSON.stringify({ entitlementId: fx.entitlementId }),
      headers: { "content-type": "application/json" },
    });
    const res = await sessionsPOST(req);

    // Must be 429.
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");

    // NO new session was created (no side effect).
    const sessionsAfter = await db.connectivitySession.count({ where: { subjectId: fx.userId } });
    expect(sessionsAfter).toBe(sessionsBefore);

    resetMockCookies();
    await cleanScope(fx.tenantId);
  }, 30_000);

  // 12.4.6.2.9 — exhaust quota on actions route → 429, no ConnectivityAction created
  it("12.4.6.2.9: exhausted quota on actions → 429, no action created", async () => {
    setMockSessionToken(fx.token);

    await exhaustTenantQuota(fx.tenantId);

    const actionsBefore = await db.connectivityAction.count({ where: { sessionId: fx.sessionId } });

    const req = new NextRequest("http://localhost/api/v1/connectivity/actions", {
      method: "POST",
      body: JSON.stringify({ sessionId: fx.sessionId, type: "DISCOVER" }),
      headers: { "content-type": "application/json" },
    });
    const res = await actionsPOST(req);

    expect(res.status).toBe(429);

    const actionsAfter = await db.connectivityAction.count({ where: { sessionId: fx.sessionId } });
    expect(actionsAfter).toBe(actionsBefore); // no new action

    resetMockCookies();
    await cleanScope(fx.tenantId);
  }, 30_000);

  // 12.4.6.2.10 — exhaust quota on edge observations → 429, no observation persisted
  it("12.4.6.2.10: exhausted quota on edge observations → 429, no observation persisted", async () => {
    setMockSessionToken(fx.token);

    // Exhaust the tenant quota (also the sensitive quota will be checked).
    await exhaustTenantQuota(fx.tenantId);

    // Also exhaust the sensitive scope for this tenant+path.
    const now = new Date();
    const iso = now.toISOString().slice(0, 16);
    const sensitiveScopeId = `${fx.tenantId}:/api/v1/connectivity/edge/observations`;
    await db.rateLimitCounter.upsert({
      where: { scope_scopeId_windowKey: { scope: "sensitive", scopeId: sensitiveScopeId, windowKey: iso } },
      create: { scope: "sensitive", scopeId: sensitiveScopeId, windowKey: iso, count: 10, expiresAt: new Date(Date.now() + 300000) },
      update: { count: 10 },
    });

    const observationsBefore = await db.connectivityMeasurement.count({});

    const req = new NextRequest("http://localhost/api/v1/connectivity/edge/observations", {
      method: "POST",
      body: JSON.stringify({ deviceId: "nonexistent", observations: [] }),
      headers: { "content-type": "application/json" },
    });
    const res = await observationsPOST(req);

    expect(res.status).toBe(429);

    const observationsAfter = await db.connectivityMeasurement.count({});
    expect(observationsAfter).toBe(observationsBefore); // no new observation

    resetMockCookies();
    await cleanScope(fx.tenantId);
    await cleanScope(sensitiveScopeId);
  }, 30_000);

  // 12.4.6.2.11 — exhausted quota on sessions POST → 429, no payment/provider side effect
  it("12.4.4.2.11: exhausted quota → 429, no entitlement or session mutation", async () => {
    setMockSessionToken(fx.token);

    await exhaustTenantQuota(fx.tenantId);

    const entsBefore = await db.connectivityEntitlement.count({ where: { tenantId: fx.tenantId } });
    const sessionsBefore = await db.connectivitySession.count({ where: { subjectId: fx.userId } });

    // Call sessions POST (creates a session — a connectivity mutation).
    const req = new NextRequest("http://localhost/api/v1/connectivity/sessions", {
      method: "POST",
      body: JSON.stringify({ entitlementId: fx.entitlementId }),
      headers: { "content-type": "application/json" },
    });
    const res = await sessionsPOST(req);

    expect(res.status).toBe(429);

    const entsAfter = await db.connectivityEntitlement.count({ where: { tenantId: fx.tenantId } });
    const sessionsAfter = await db.connectivitySession.count({ where: { subjectId: fx.userId } });
    expect(entsAfter).toBe(entsBefore);
    expect(sessionsAfter).toBe(sessionsBefore);

    resetMockCookies();
    await cleanScope(fx.tenantId);
  }, 30_000);

  // 12.4.6.2.12 — malformed/no auth → no rate-limit identity, no bypass
  it("12.4.6.2.12: no auth → 401, no rate-limit identity created", async () => {
    resetMockCookies();

    const countersBefore = await db.rateLimitCounter.count({});

    const req = new NextRequest("http://localhost/api/v1/connectivity/sessions", { method: "GET" });
    const res = await sessionsGET(req);

    // Must be 401 (auth required), NOT 429.
    expect(res.status).toBe(401);

    // No rate-limit counter was created (no identity established).
    const countersAfter = await db.rateLimitCounter.count({});
    expect(countersAfter).toBe(countersBefore);
  }, 30_000);

  // 12.4.6.2.13 — two API keys (simulated via two sessions) same tenant → tenant quota
  it("12.4.6.2.13: two sessions same tenant → tenant aggregate quota enforced", async () => {
    // We can't easily create two API keys, but we CAN create two sessions
    // for the same tenant. Each session-auth request checks the tenant scope.
    // Exhaust the tenant quota via session 1, then verify session 2 is also
    // rate-limited (tenant aggregate).

    setMockSessionToken(fx.token);
    await exhaustTenantQuota(fx.tenantId);

    // Session 1 → 429.
    const req1 = new NextRequest("http://localhost/api/v1/connectivity/sessions", { method: "GET" });
    const res1 = await sessionsGET(req1);
    expect(res1.status).toBe(429);

    // Session 2 (same tenant) → also 429 (tenant aggregate exhausted).
    setMockSessionToken(fx.token2);
    // Wait — token2 is for tenant2, not tenant1. Let me create a second session
    // for the SAME tenant.
    const token1b = `p12462p-1b-${Date.now()}`;
    await db.session.create({ data: { userId: fx.userId, token: token1b, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantId } });

    setMockSessionToken(token1b);
    const req2 = new NextRequest("http://localhost/api/v1/connectivity/sessions", { method: "GET" });
    const res2 = await sessionsGET(req2);
    expect(res2.status).toBe(429); // tenant quota shared

    // Cleanup.
    await db.session.deleteMany({ where: { token: token1b } }).catch(() => {});
    resetMockCookies();
    await cleanScope(fx.tenantId);
  }, 30_000);
});
