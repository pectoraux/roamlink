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
 * Returns null if the user has no active tenant or no tenant memberships.
 */
export async function getActiveTenant(user: AuthUser): Promise<TenantContext | null> {
  const token = await getSessionToken();

  // Resolve the active tenant from THIS session (per-session, not per-user)
  let activeTenantId: string | null = null;
  if (token) {
    const session = await db.session.findUnique({
      where: { token },
      select: { activeTenantId: true },
    });
    activeTenantId = session?.activeTenantId ?? null;
  }

  if (!activeTenantId) {
    // No active tenant on this session — try first membership (convenience
    // for single-tenant users). We do NOT persist this to the session here;
    // setActiveTenant must be called explicitly to persist.
    const firstMembership = await db.tenantUser.findFirst({
      where: { userId: user.id, tenant: { status: "active" } },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!firstMembership) return null;
    return {
      tenantId: firstMembership.tenantId,
      role: firstMembership.role,
      tenant: firstMembership.tenant,
    };
  }

  // Validate membership
  const membership = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId: activeTenantId, userId: user.id } },
    include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
  });
  if (!membership) {
    // Stale activeTenantId — user was removed from this tenant
    return null;
  }
  if (membership.tenant.status !== "active") {
    return null;
  }
  return {
    tenantId: membership.tenantId,
    role: membership.role,
    tenant: membership.tenant,
  };
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
