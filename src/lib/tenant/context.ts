/**
 * Tenant context — active-tenant resolution for the reseller control plane.
 *
 * Phase 2B.1: PER-SESSION active tenant.
 *
 * The active tenant belongs to the SPECIFIC authenticated session, not the
 * user globally. A user logged in on two devices can have a different active
 * tenant on each device. Changing the active tenant on one device does NOT
 * affect the other device's session.
 *
 * The session token (from the `esim_session` cookie) is the key — we resolve
 * the session by token, read/update its `activeTenantId` field.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { AuthUser } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/auth";
import { cookies } from "next/headers";

export type TenantContext = {
  tenantId: string;
  role: string; // owner | admin | sales | support | billing | operations | viewer
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
};

/**
 * Get the session token from the current request's cookies.
 * Returns null if no session cookie is present.
 */
async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Resolve the active tenant for a user FROM THE CURRENT SESSION.
 *
 * Phase 2B.1: Uses the session token from cookies to find the SPECIFIC session.
 * The activeTenantId on that session is the active tenant — not a global
 * user-level setting.
 *
 * Phase 12.2: Fail-closed tenant resolution.
 * - If activeTenantId exists on the session → verify membership + active status.
 *   Stale or inactive → null (deny).
 * - If activeTenantId does NOT exist:
 *   - 0 active memberships → null (deny)
 *   - exactly 1 active membership → implicit resolution allowed (convenience)
 *   - 2+ active memberships → null (deny — requires explicit selection)
 * - Never selects an arbitrary "first" tenant for multi-tenant users.
 *
 * Returns null if the user has no active tenant or cannot be resolved.
 */
export async function getActiveTenant(user: AuthUser): Promise<TenantContext | null> {
  const token = await getSessionToken();

  // Resolve the active tenant from THIS session (per-session, not per-user)
  let activeTenantId: string | null = null;
  if (token) {
    const session = await db.session.findUnique({
      where: { token },
      select: { activeTenantId: true, userId: true },
    });
    // Phase 12.2: Verify the session belongs to the authenticated user.
    if (!session || session.userId !== user.id) return null;
    activeTenantId = session.activeTenantId ?? null;
  }

  if (activeTenantId) {
    // Phase 12.2: Verify membership + active status.
    const membership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: activeTenantId, userId: user.id } },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!membership) return null;          // stale activeTenantId — user was removed
    if (membership.tenant.status !== "active") return null; // tenant inactive
    return {
      tenantId: membership.tenantId,
      role: membership.role,
      tenant: membership.tenant,
    };
  }

  // Phase 12.2: No activeTenantId on session — fail-closed resolution.
  // Count active memberships to decide.
  const activeMemberships = await db.tenantUser.findMany({
    where: { userId: user.id, tenant: { status: "active" } },
    include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (activeMemberships.length === 0) return null;       // 0 → deny
  if (activeMemberships.length === 1) {                    // 1 → implicit
    return {
      tenantId: activeMemberships[0].tenantId,
      role: activeMemberships[0].role,
      tenant: activeMemberships[0].tenant,
    };
  }
  // 2+ → deny, require explicit selection
  return null;
}

/**
 * Require an active tenant context or throw 403.
 */
export async function requireTenantContext(user: AuthUser): Promise<TenantContext> {
  const ctx = await getActiveTenant(user);
  if (!ctx) {
    throw new AppError(
      "authorization",
      "No active tenant context",
      403,
      "You don't have an active reseller tenant. Ask your administrator to add you to a tenant.",
    );
  }
  return ctx;
}

/**
 * Require a specific tenant role (or set of roles).
 * Must be called after requireTenantContext.
 */
export function requireTenantRole(ctx: TenantContext, roles: string[]): void {
  if (!roles.includes(ctx.role)) {
    throw new AppError(
      "authorization",
      `Tenant role '${ctx.role}' is not in [${roles.join(", ")}]`,
      403,
      "You don't have permission to perform this action.",
    );
  }
}

/** All roles that can manage the tenant (owner + admin). */
export const TENANT_MANAGE_ROLES = ["owner", "admin"];
/** All roles that can create/modify tenant data (owner + admin + sales + operations). */
export const TENANT_WRITE_ROLES = ["owner", "admin", "sales", "operations"];
/** All roles that can view tenant data. */
export const TENANT_VIEW_ROLES = ["owner", "admin", "sales", "support", "billing", "operations", "viewer"];

/**
 * Phase 12.2: Assert that a client-supplied tenantId matches the authenticated
 * tenant context. If the client-supplied tenantId is null/undefined, it's allowed
 * (the caller is not trying to override the session tenant). If it's present but
 * doesn't match ctx.tenantId, throw 403.
 *
 * Use this helper wherever routes accept a tenantId from the client.
 *
 *   assertTenantScope(ctx, body.tenantId)  →  throws if body.tenantId !== ctx.tenantId
 */
export function assertTenantScope(ctx: TenantContext, requestedTenantId: string | null | undefined): void {
  if (requestedTenantId == null) return; // omitted → allowed
  if (requestedTenantId === ctx.tenantId) return; // matches → allowed
  throw new AppError(
    "authorization",
    `Client-supplied tenantId '${requestedTenantId}' does not match session tenant '${ctx.tenantId}'`,
    403,
    "You don't have access to this tenant.",
  );
}

/**
 * Set the active tenant for the CURRENT SESSION ONLY.
 *
 * Phase 2B.1: Updates only the session identified by the current request's
 * cookie, NOT all sessions for the user. A user on another device keeps
 * their own active tenant.
 *
 * Validates that the user is a member of the target tenant.
 */
export async function setActiveTenant(userId: string, tenantId: string): Promise<void> {
  // Validate membership
  const membership = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });
  if (!membership) {
    throw new AppError(
      "authorization",
      `User ${userId} is not a member of tenant ${tenantId}`,
      403,
      "You don't have access to this tenant.",
    );
  }

  // Update ONLY the current session (identified by the cookie token)
  const token = await getSessionToken();
  if (!token) {
    throw new AppError("auth", "No active session", 401, "No active session found.");
  }

  const result = await db.session.updateMany({
    where: { token, userId }, // scoped to THIS session AND this user
    data: { activeTenantId: tenantId },
  });

  if (result.count === 0) {
    throw new AppError("auth", "Session not found", 404, "Your session could not be found. Please sign in again.");
  }
}

/**
 * List all tenants a user belongs to (for the tenant switcher UI).
 */
export async function listUserTenants(userId: string): Promise<Array<{
  tenantId: string;
  role: string;
  name: string;
  slug: string;
  status: string;
}>> {
  const memberships = await db.tenantUser.findMany({
    where: { userId, tenant: { status: "active" } },
    include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({
    tenantId: m.tenant.id,
    role: m.role,
    name: m.tenant.name,
    slug: m.tenant.slug,
    status: m.tenant.status,
  }));
}
