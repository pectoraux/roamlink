import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES } from "@/lib/tenant/context";
import { db } from "@/lib/db";
import { audit } from "@/lib/orders/idempotency";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);
    const { id } = await params;
    const body = await req.json();
    const { role } = body;
    const validRoles = ["owner", "admin", "sales", "support", "billing", "operations", "viewer"];
    if (!validRoles.includes(role)) {
      return json({ error: "Invalid role" }, 400);
    }
    const membership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } },
    });
    if (!membership) {
      throw new AppError("not_found", "Member not found", 404, "This user is not a member of your tenant.");
    }
    await db.tenantUser.update({
      where: { id: membership.id },
      data: { role },
    });
    await audit({
      tenantId: ctx.tenantId,
      userId: user.id,
      action: "tenant.member_role_changed",
      entity: "tenant",
      entityId: ctx.tenantId,
      detail: { targetUserId: id, oldRole: membership.role, newRole: role },
    });
    return json({ ok: true }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);
    const { id } = await params;
    const membership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } },
    });
    if (!membership) {
      throw new AppError("not_found", "Member not found", 404, "This user is not a member of your tenant.");
    }
    if (membership.role === "owner") {
      throw new AppError("validation", "Cannot remove owner", 400, "The owner cannot be removed from the tenant.");
    }
    await db.tenantUser.delete({ where: { id: membership.id } });
    await audit({
      tenantId: ctx.tenantId,
      userId: user.id,
      action: "tenant.member_removed",
      entity: "tenant",
      entityId: ctx.tenantId,
      detail: { removedUserId: id },
    });
    return json({ ok: true }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
