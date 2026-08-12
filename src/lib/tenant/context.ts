/**
 * Tenant context — active-tenant resolution for the reseller control plane.
 *
 * Phase 2B: A user may belong to multiple tenants. The active tenant is
 * stored on the Session (session.activeTenantId) and validated server-side
 * against TenantUser membership on every request.
 *
 * This module provides:
 *   - getActiveTenant(user) — resolve + validate the active tenant
 *   - setActiveTenant(userId, tenantId) — switch active tenant
 *   - requireTenantContext(user) — require an active tenant or throw
 *   - requireTenantRole(user, roles) — require a specific tenant role
 *
 * The tenant context is the authorization boundary for ALL /api/tenant/* routes.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { AuthUser } from "@/lib/auth";

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
 * Resolve the active tenant for a user. Validates that:
 *   1. The user is a member of the active tenant (TenantUser row exists)
 *   2. The tenant is active
 *
 * Returns null if the user has no active tenant or no tenant memberships.
 */
export async function getActiveTenant(user: AuthUser): Promise<TenantContext | null> {
  // Get the user's sessions to find activeTenantId
  const session = await db.session.findFirst({
    where: { userId: user.id, activeTenantId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { activeTenantId: true },
  });

  const activeTenantId = session?.activeTenantId;
  if (!activeTenantId) {
    // No active tenant set — try first membership (convenience for single-tenant users)
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
 * Set the active tenant for a user's current session.
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
  // Update the user's most recent session
  await db.session.updateMany({
    where: { userId },
    data: { activeTenantId: tenantId },
  });
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
