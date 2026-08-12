import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES } from "@/lib/tenant/context";
import { db } from "@/lib/db";
import { audit } from "@/lib/orders/idempotency";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);
    const { id } = await params;
    const key = await db.apiKey.findUnique({ where: { id } });
    if (!key || key.tenantId !== ctx.tenantId) {
      throw new AppError("not_found", "API key not found", 404, "API key not found.");
    }
    await db.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await audit({
      tenantId: ctx.tenantId,
      userId: user.id,
      action: "api_key.revoked",
      entity: "api_key",
      entityId: id,
    });
    return json({ ok: true }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
