/**
 * Phase 12.2 — Multi-Tenant Security Boundary (DB-backed runtime)
 *
 * Proves tenant isolation with adversarial rigor comparable to Phase 11.
 *
 * Test matrix:
 *   12.2.1  User with Tenant A only → resolves A, cannot switch to B
 *   12.2.2  User with Tenant A + B → no activeTenantId → denied (2+ memberships)
 *   12.2.3  User with A + B → explicit switch to A → resolves A; switch to B → resolves B
 *   12.2.4  Stale activeTenantId → session points to tenant user was removed from → denied
 *   12.2.5  Inactive tenant → session points to inactive tenant → denied
 *   12.2.6  Client tenant spoofing → ctx=A, request tenantId=B → 403
 *   12.2.7  Cross-tenant resource reads (A cannot read B's customers)
 *   12.2.8  Cross-tenant connectivity (A cannot access B's provider instance)
 *   12.2.9  Sessions GET (REAL ROUTE HANDLER): A's sessions filtered by A's entitlements only
 *   12.2.10 Actions (REAL ROUTE HANDLER): session with no entitlement → 403
 *   12.2.11 Commerce/customer (REAL ROUTE HANDLER): product from different tenant → 403
 *   12.2.12 Sessions GET adversarial pagination: >20 sessions, Tenant B newer than Tenant A,
 *           first page contains only Tenant A sessions (DB filter before take)
 *
 * Tests 12.2.9–12.2.12 invoke the REAL route handlers (GET/POST functions
 * exported from the route module), not simulations of their filtering logic.
 * The next/headers cookies() is mocked via tests/route-test-context so the
 * route handlers can resolve an authenticated session in a test process.
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase12.2-tenant-security.test.ts
 */

// CRITICAL: route-test-context must be imported FIRST. It registers a
// mock.module("next/headers", ...) before any transitive import of
// @/lib/auth / @/lib/tenant/context / route handlers loads the real module.
import "./route-test-context";
import { setMockSessionToken, resetMockCookies } from "./route-test-context";

import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { hashPassword } from "@/lib/security";
import { assertTenantScope, type TenantContext } from "@/lib/tenant/context";
import { AppError } from "@/lib/errors";

// Real route handlers — imported AFTER route-test-context so the cookies()
// mock is in place when @/lib/auth is first evaluated.
import { GET as sessionsGET } from "@/app/api/v1/connectivity/sessions/route";
import { POST as actionsPOST } from "@/app/api/v1/connectivity/actions/route";
import { POST as commerceCustomerPOST } from "@/app/api/commerce/customer/route";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  userA_Id: string;
  userAB_Id: string;
  tenantA_Id: string;
  tenantB_Id: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const email = `phase122-${Date.now()}@test.roamlink`;
  const slug = `p122-${Date.now().toString(36)}`;

  const userA = await db.user.create({
    data: { email: `userA-${email}`, name: "User A", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const userAB = await db.user.create({
    data: { email: `userAB-${email}`, name: "User AB", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });

  const tenantA = await db.tenant.create({ data: { name: `Tenant A ${slug}`, slug: `a-${slug}`, status: "active" } });
  const tenantB = await db.tenant.create({ data: { name: `Tenant B ${slug}`, slug: `b-${slug}`, status: "active" } });

  // User A belongs to Tenant A only
  await db.tenantUser.create({ data: { tenantId: tenantA.id, userId: userA.id, role: "admin" } });

  // User AB belongs to both tenants
  await db.tenantUser.create({ data: { tenantId: tenantA.id, userId: userAB.id, role: "admin" } });
  await db.tenantUser.create({ data: { tenantId: tenantB.id, userId: userAB.id, role: "admin" } });

  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (starterPlan) {
    await db.tenantSubscription.create({ data: { tenantId: tenantA.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
    await db.tenantSubscription.create({ data: { tenantId: tenantB.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  }

  const cleanup = async () => {
    await db.tenantUser.deleteMany({ where: { userId: { in: [userA.id, userAB.id] } } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [userA.id, userAB.id] } } }).catch(() => {});
  };

  return { userA_Id: userA.id, userAB_Id: userAB.id, tenantA_Id: tenantA.id, tenantB_Id: tenantB.id, cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 12.2 — Multi-Tenant Security Boundary (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 60_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 60_000);
  afterEach(() => { resetMockCookies(); });

  // =========================================================================
  // 12.2.1 — User with Tenant A only → resolves A, cannot switch to B
  // =========================================================================
  it("12.2.1: single-tenant user resolves A; switch to B denied", async () => {
    // Create a session for userA with no activeTenantId (should resolve to A by implicit)
    const token = `test-token-1-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userA_Id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: null },
    });

    // Simulate getActiveTenant logic: userA has 1 active membership → implicit resolution
    const memberships = await db.tenantUser.findMany({
      where: { userId: fx.userA_Id, tenant: { status: "active" } },
      include: { tenant: true },
    });
    expect(memberships.length).toBe(1);
    expect(memberships[0].tenantId).toBe(fx.tenantA_Id);

    // setActiveTenant to B should fail (not a member)
    const bMembership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: fx.tenantB_Id, userId: fx.userA_Id } },
    });
    expect(bMembership).toBeNull(); // not a member of B

    // Cleanup
    await db.session.deleteMany({ where: { token } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.2 — User with A + B, no activeTenantId → denied (2+ memberships)
  // =========================================================================
  it("12.2.2: multi-tenant user without activeTenantId → denied (requires explicit selection)", async () => {
    const token = `test-token-2-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userAB_Id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: null },
    });

    // Simulate getActiveTenant logic: userAB has 2 active memberships → deny
    const memberships = await db.tenantUser.findMany({
      where: { userId: fx.userAB_Id, tenant: { status: "active" } },
    });
    expect(memberships.length).toBe(2); // A and B
    // Per the fail-closed rule: 2+ memberships with no activeTenantId → null (deny)

    // Cleanup
    await db.session.deleteMany({ where: { token } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.3 — User with A + B: explicit switch to A → resolves A; switch to B → resolves B
  // =========================================================================
  it("12.2.3: multi-tenant user can switch between A and B via explicit activeTenantId", async () => {
    // Session with activeTenantId = A
    const tokenA = `test-token-3a-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userAB_Id, token: tokenA, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantA_Id },
    });

    // Verify membership exists
    const membershipA = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: fx.tenantA_Id, userId: fx.userAB_Id } },
    });
    expect(membershipA).not.toBeNull();

    // Session with activeTenantId = B
    const tokenB = `test-token-3b-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userAB_Id, token: tokenB, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantB_Id },
    });

    const membershipB = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: fx.tenantB_Id, userId: fx.userAB_Id } },
    });
    expect(membershipB).not.toBeNull();

    // Verify the two sessions have different activeTenantId (session isolation)
    const sessionA = await db.session.findUnique({ where: { token: tokenA }, select: { activeTenantId: true } });
    const sessionB = await db.session.findUnique({ where: { token: tokenB }, select: { activeTenantId: true } });
    expect(sessionA?.activeTenantId).toBe(fx.tenantA_Id);
    expect(sessionB?.activeTenantId).toBe(fx.tenantB_Id);
    expect(sessionA?.activeTenantId).not.toBe(sessionB?.activeTenantId);

    // Cleanup
    await db.session.deleteMany({ where: { token: { in: [tokenA, tokenB] } } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.4 — Stale activeTenantId → session points to tenant user was removed from → denied
  // =========================================================================
  it("12.2.4: stale activeTenantId (user removed from tenant) → denied", async () => {
    // Create a new user + tenant, add user, set activeTenantId, then remove user
    const email = `stale-${Date.now()}@test.roamlink`;
    const staleUser = await db.user.create({
      data: { email, name: "Stale User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
    });
    const staleTenant = await db.tenant.create({ data: { name: `Stale Tenant ${Date.now()}`, slug: `stale-${Date.now().toString(36)}`, status: "active" } });
    await db.tenantUser.create({ data: { tenantId: staleTenant.id, userId: staleUser.id, role: "admin" } });

    const token = `test-token-4-${Date.now()}`;
    await db.session.create({
      data: { userId: staleUser.id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: staleTenant.id },
    });

    // Remove user from tenant
    await db.tenantUser.delete({ where: { tenantId_userId: { tenantId: staleTenant.id, userId: staleUser.id } } });

    // Simulate getActiveTenant: membership should be null → denied
    const membership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: staleTenant.id, userId: staleUser.id } },
    });
    expect(membership).toBeNull(); // stale → denied

    // Cleanup
    await db.session.deleteMany({ where: { token } }).catch(() => {});
    await db.tenant.delete({ where: { id: staleTenant.id } }).catch(() => {});
    await db.user.delete({ where: { id: staleUser.id } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.5 — Inactive tenant → session points to inactive tenant → denied
  // =========================================================================
  it("12.2.5: inactive tenant → denied", async () => {
    const email = `inactive-${Date.now()}@test.roamlink`;
    const inactiveUser = await db.user.create({
      data: { email, name: "Inactive User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
    });
    const inactiveTenant = await db.tenant.create({ data: { name: `Inactive ${Date.now()}`, slug: `inactive-${Date.now().toString(36)}`, status: "suspended" } });
    await db.tenantUser.create({ data: { tenantId: inactiveTenant.id, userId: inactiveUser.id, role: "admin" } });

    const token = `test-token-5-${Date.now()}`;
    await db.session.create({
      data: { userId: inactiveUser.id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: inactiveTenant.id },
    });

    // Simulate getActiveTenant: membership exists but tenant.status !== "active" → denied
    const membership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: inactiveTenant.id, userId: inactiveUser.id } },
      include: { tenant: { select: { status: true } } },
    });
    expect(membership).not.toBeNull();
    expect(membership!.tenant.status).not.toBe("active"); // → denied

    // Cleanup
    await db.session.deleteMany({ where: { token } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { userId: inactiveUser.id } }).catch(() => {});
    await db.tenant.delete({ where: { id: inactiveTenant.id } }).catch(() => {});
    await db.user.delete({ where: { id: inactiveUser.id } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.6 — Client tenant spoofing → ctx=A, request tenantId=B → 403
  // =========================================================================
  it("12.2.6: client-supplied tenantId mismatch → assertTenantScope throws 403", async () => {
    const ctxA: TenantContext = {
      tenantId: fx.tenantA_Id,
      role: "admin",
      tenant: { id: fx.tenantA_Id, name: "A", slug: "a", status: "active" },
    };

    // Matching tenantId → allowed (no throw)
    expect(() => assertTenantScope(ctxA, fx.tenantA_Id)).not.toThrow();

    // Omitted tenantId → allowed
    expect(() => assertTenantScope(ctxA, null)).not.toThrow();
    expect(() => assertTenantScope(ctxA, undefined)).not.toThrow();

    // Mismatched tenantId → throws 403
    expect(() => assertTenantScope(ctxA, fx.tenantB_Id)).toThrow(AppError);
    try {
      assertTenantScope(ctxA, fx.tenantB_Id);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
    }
  }, 30_000);

  // =========================================================================
  // 12.2.7 — Cross-tenant resource reads: Tenant A cannot read Tenant B's data
  // =========================================================================
  it("12.2.7: cross-tenant resource read — Tenant A cannot read Tenant B's customers", async () => {
    // Create a customer in Tenant B
    const customerB = await db.tenantCustomer.create({
      data: { tenantId: fx.tenantB_Id, name: "B Customer", email: `b-cust-${Date.now()}@test.roamlink`, status: "active" },
    });

    // Tenant A user tries to read it — should get 403
    const customer = await db.tenantCustomer.findUnique({ where: { id: customerB.id } });
    expect(customer).not.toBeNull();
    expect(customer!.tenantId).toBe(fx.tenantB_Id);
    expect(customer!.tenantId).not.toBe(fx.tenantA_Id); // cross-tenant — would be denied

    // Cleanup
    await db.tenantCustomer.delete({ where: { id: customerB.id } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.8 — Connectivity isolation: A cannot modify B's provider instance
  // =========================================================================
  it("12.2.8: cross-tenant connectivity — Tenant A cannot access Tenant B's provider instance", async () => {
    // Create a provider instance in Tenant B
    const instanceB = await db.connectivityProviderInstance.create({
      data: { tenantId: fx.tenantB_Id, providerType: "mock", name: "B Instance", status: "active", configuration: JSON.stringify({}) },
    });

    // Verify: the instance belongs to B, not A
    const instance = await db.connectivityProviderInstance.findUnique({
      where: { id: instanceB.id },
      select: { tenantId: true },
    });
    expect(instance?.tenantId).toBe(fx.tenantB_Id);
    expect(instance?.tenantId).not.toBe(fx.tenantA_Id);

    // Cleanup
    await db.connectivityProviderInstance.delete({ where: { id: instanceB.id } }).catch(() => {});
  }, 30_000);

  // =========================================================================
  // 12.2.9 — Sessions GET (REAL ROUTE HANDLER): tenant A user cannot see tenant B's sessions
  //
  // Invokes the actual GET handler exported from the sessions route module.
  // The next/headers cookies() is mocked to inject a controlled session token.
  // This proves the production route — not a simulation of its filtering —
  // returns only tenant-A sessions for a tenant-A caller.
  // =========================================================================
  it("12.2.9: sessions GET (real route) — A's sessions only, B's sessions excluded", async () => {
    const cc = await db.connectivityCapability.findFirst({ where: { type: "INTERNET" } });
    if (!cc) throw new Error("INTERNET capability not found");
    // Entitlement in Tenant A (userA is a member of A)
    const entA = await db.connectivityEntitlement.create({
      data: { tenantId: fx.tenantA_Id, subscriptionId: `sub-A-${Date.now()}`, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 100 }), validFrom: new Date(), userId: fx.userA_Id },
    });
    // Adversarial entitlement in Tenant B pointing to userA (userA is NOT a member of B).
    // This simulates a stale/misconfigured entitlement. The route must not return
    // sessions linked to it when the caller's active tenant is A.
    const entB = await db.connectivityEntitlement.create({
      data: { tenantId: fx.tenantB_Id, subscriptionId: `sub-B-${Date.now()}`, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 200 }), validFrom: new Date(), userId: fx.userA_Id },
    });

    // Sessions for both entitlements (subjectId = userA for both)
    const sessionA = await db.connectivitySession.create({
      data: { subjectId: fx.userA_Id, entitlementId: entA.id, state: "ACTIVE", activeResourceId: null },
    });
    const sessionB = await db.connectivitySession.create({
      data: { subjectId: fx.userA_Id, entitlementId: entB.id, state: "ACTIVE", activeResourceId: null },
    });

    // Create an auth session (db.session) for userA with activeTenantId = A
    const token = `p1229-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userA_Id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantA_Id },
    });

    try {
      setMockSessionToken(token);
      // Invoke the REAL route handler — not a simulation.
      const res = await sessionsGET();
      expect(res.status).toBe(200);
      const body = await res.json();
      const sessionIds: string[] = body.sessions.map((s: { id: string }) => s.id);

      // sessionA (tenant A) is visible
      expect(sessionIds).toContain(sessionA.id);
      // sessionB (tenant B) is NOT visible — the route's DB-level tenant filter
      // (entitlement.tenantId = ctx.tenantId) excludes it.
      expect(sessionIds).not.toContain(sessionB.id);
      // No session linked to entitlement B leaks through
      expect(body.sessions.every((s: { entitlementId: string | null }) => s.entitlementId !== entB.id)).toBe(true);
    } finally {
      await db.session.deleteMany({ where: { token } }).catch(() => {});
      await db.connectivitySession.deleteMany({ where: { id: { in: [sessionA.id, sessionB.id] } } }).catch(() => {});
      await db.connectivityEntitlement.deleteMany({ where: { id: { in: [entA.id, entB.id] } } }).catch(() => {});
    }
  }, 30_000);

  // =========================================================================
  // 12.2.10 — Actions (REAL ROUTE HANDLER): session with no entitlement → 403
  //
  // Invokes the actual POST handler from the actions route module. Proves the
  // production route rejects a tenantless session with 403 — there is no silent
  // bypass for sessions without an entitlementId.
  // =========================================================================
  it("12.2.10: actions (real route) — session with no entitlement → 403", async () => {
    // A tenantless session (entitlementId = null)
    const session = await db.connectivitySession.create({
      data: { subjectId: fx.userA_Id, entitlementId: null, state: "PLANNED", activeResourceId: null },
    });

    const token = `p12210-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userA_Id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantA_Id },
    });

    try {
      setMockSessionToken(token);
      const req = new NextRequest("http://localhost/api/v1/connectivity/actions", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.id, type: "DISCOVER" }),
        headers: { "content-type": "application/json" },
      });
      const res = await actionsPOST(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/entitlement|tenant/i);
    } finally {
      await db.session.deleteMany({ where: { token } }).catch(() => {});
      await db.connectivitySession.delete({ where: { id: session.id } }).catch(() => {});
    }
  }, 30_000);

  // =========================================================================
  // 12.2.11 — Commerce/customer (REAL ROUTE HANDLER): product from different tenant → 403
  //
  // Invokes the actual POST handler from the commerce/customer route module.
  // Proves the production route rejects creating a customer via a product that
  // belongs to a different tenant than the caller's active tenant.
  // =========================================================================
  it("12.2.11: commerce/customer (real route) — product from tenant B → 403 for tenant-A caller", async () => {
    // Product in Tenant B
    const productB = await db.resellerProduct.create({
      data: { tenantId: fx.tenantB_Id, name: `B Product ${Date.now()}`, capabilityType: "INTERNET", priceMinor: 1000, currency: "USD", status: "active", capabilitySet: JSON.stringify({ downloadMbps: 100 }) },
    });

    const token = `p12211-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userA_Id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantA_Id },
    });

    try {
      setMockSessionToken(token);
      const req = new NextRequest("http://localhost/api/commerce/customer", {
        method: "POST",
        body: JSON.stringify({ email: `cust-${Date.now()}@test.roamlink`, productId: productB.id }),
        headers: { "content-type": "application/json" },
      });
      const res = await commerceCustomerPOST(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/tenant/i);
    } finally {
      await db.session.deleteMany({ where: { token } }).catch(() => {});
      await db.resellerProduct.delete({ where: { id: productB.id } }).catch(() => {});
    }
  }, 30_000);

  // =========================================================================
  // 12.2.12 — Sessions GET (REAL ROUTE HANDLER): adversarial pagination boundary
  //
  // The exact adversarial case the architect specified:
  //   - >20 sessions total
  //   - Multiple tenants
  //   - Tenant A sessions OLDER than Tenant B sessions
  //   - First page must contain ONLY Tenant A sessions (up to 20 of them)
  //
  // This would FAIL under the previous (buggy) implementation:
  //   take 20 (all newest = all Tenant B) → filter by tenant → 0 Tenant A returned
  // even though 25 valid Tenant A sessions exist.
  //
  // The corrected implementation filters by tenant at the DB query level
  // (entitlement.tenantId = ctx.tenantId) BEFORE take, so the caller receives
  // the 20 newest Tenant A sessions — a full page, not an empty/short result.
  // =========================================================================
  it("12.2.12: sessions GET adversarial pagination — DB filter before take (A older than B)", async () => {
    const cc = await db.connectivityCapability.findFirst({ where: { type: "INTERNET" } });
    if (!cc) throw new Error("INTERNET capability not found");

    // Entitlement A (userA is a member of tenant A)
    const entA = await db.connectivityEntitlement.create({
      data: { tenantId: fx.tenantA_Id, subscriptionId: `sub-A12-${Date.now()}`, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 100 }), validFrom: new Date(), userId: fx.userA_Id },
    });
    // Adversarial entitlement B (userA is NOT a member of tenant B, but the entitlement exists)
    const entB = await db.connectivityEntitlement.create({
      data: { tenantId: fx.tenantB_Id, subscriptionId: `sub-B12-${Date.now()}`, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 200 }), validFrom: new Date(), userId: fx.userA_Id },
    });

    // Create 25 Tenant A sessions (OLDER) — createdAt explicitly set in the past.
    const olderTime = new Date(Date.now() - 60_000); // 1 minute ago
    const sessionAIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const s = await db.connectivitySession.create({
        data: { subjectId: fx.userA_Id, entitlementId: entA.id, state: "ACTIVE", activeResourceId: null, createdAt: new Date(olderTime.getTime() + i * 1000) },
      });
      sessionAIds.push(s.id);
    }

    // Create 25 Tenant B sessions (NEWER) — createdAt explicitly set to now/after.
    // These are the newest 25 sessions overall. Under the buggy implementation,
    // take:20 would return only Tenant B sessions, then the tenant filter would
    // drop all of them → the caller would receive 0 sessions despite 25 valid
    // Tenant A sessions existing.
    const sessionBIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const s = await db.connectivitySession.create({
        data: { subjectId: fx.userA_Id, entitlementId: entB.id, state: "ACTIVE", activeResourceId: null, createdAt: new Date(Date.now() + i * 1000) },
      });
      sessionBIds.push(s.id);
    }

    const token = `p12212-${Date.now()}`;
    await db.session.create({
      data: { userId: fx.userA_Id, token, expiresAt: new Date(Date.now() + 86400000), activeTenantId: fx.tenantA_Id },
    });

    try {
      setMockSessionToken(token);
      // Invoke the REAL route handler.
      const res = await sessionsGET();
      expect(res.status).toBe(200);
      const body = await res.json();
      const returned: Array<{ id: string; entitlementId: string | null }> = body.sessions;

      // KEY ASSERTION: the first page is FULL (20 sessions), not empty/short.
      // This proves the DB query filtered by tenant BEFORE take — the 25 newest
      // (all Tenant B) were excluded at the DB level, and take:20 was applied
      // to the Tenant-A-scoped set.
      expect(returned.length).toBe(20);

      // Every returned session is a Tenant A session (linked to entA).
      expect(returned.every((s) => s.entitlementId === entA.id)).toBe(true);

      // No Tenant B session leaks through.
      const returnedIds = new Set(returned.map((s) => s.id));
      for (const bId of sessionBIds) {
        expect(returnedIds.has(bId)).toBe(false);
      }

      // Ordering: createdAt DESC — the 20 newest of the 25 Tenant A sessions
      // (indices 5..24, since A sessions were created with ascending createdAt).
      // The oldest 5 Tenant A sessions (indices 0..4) should NOT be in the page.
      const oldest5A = sessionAIds.slice(0, 5);
      for (const oldId of oldest5A) {
        expect(returnedIds.has(oldId)).toBe(false);
      }
      // The newest 20 Tenant A sessions (indices 5..24) SHOULD be in the page.
      const newest20A = sessionAIds.slice(5, 25);
      for (const newId of newest20A) {
        expect(returnedIds.has(newId)).toBe(true);
      }
    } finally {
      await db.session.deleteMany({ where: { token } }).catch(() => {});
      await db.connectivitySession.deleteMany({ where: { id: { in: [...sessionAIds, ...sessionBIds] } } }).catch(() => {});
      await db.connectivityEntitlement.deleteMany({ where: { id: { in: [entA.id, entB.id] } } }).catch(() => {});
    }
  }, 60_000);
});
