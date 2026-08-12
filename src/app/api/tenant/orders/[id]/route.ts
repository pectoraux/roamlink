import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getTenantOrder } from "@/lib/tenant/service";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const { id } = await params;
    const order = await getTenantOrder(id, ctx.tenantId);
    return json({ order }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
