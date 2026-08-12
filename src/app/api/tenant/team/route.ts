/**
 * Tenant Team API.
 *   GET   /api/tenant/team        — list team members
 *   POST  /api/tenant/team        — add team member (entitlement-checked)
 *   PATCH /api/tenant/team/:id    — update member role
 *   DELETE /api/tenant/team/:id   — remove member
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { assertCanAddStaff } from "@/lib/tenant/entitlements";
import { db } from "@/lib/db";
import { audit } from "@/lib/orders/idempotency";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const members = await db.tenantUser.findMany({
      where: { tenantId: ctx.tenantId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    return json({ members }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);

    const body = await req.json();
    const { email, role, name } = body;
    if (!email || !role) {
      return json({ error: "email and role are required" }, 400);
    }
    const validRoles = ["owner", "admin", "sales", "support", "billing", "operations", "viewer"];
    if (!validRoles.includes(role)) {
      return json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
    }

    // Entitlement check
    await assertCanAddStaff(ctx.tenantId);

    // Find or create the user
    let targetUser = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!targetUser) {
      // Create a placeholder user (they'll set a password via invite)
      targetUser = await db.user.create({
        data: {
          email: email.toLowerCase(),
          name: name || null,
          passwordHash: "invite-pending", // must be set via invite flow
          role: "customer",
        },
      });
    }

    // Check if already a member
    const existing = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: targetUser.id } },
    });
    if (existing) {
      throw new AppError("conflict", "Already a member", 409, "This user is already a team member.");
    }

    await db.tenantUser.create({
      data: { tenantId: ctx.tenantId, userId: targetUser.id, role },
    });
    await audit({
      tenantId: ctx.tenantId,
      userId: user.id,
      action: "tenant.member_added",
      entity: "tenant",
      entityId: ctx.tenantId,
      detail: { addedUserId: targetUser.id, role },
    });
    return json({ ok: true, member: { userId: targetUser.id, email: targetUser.email, role } }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
