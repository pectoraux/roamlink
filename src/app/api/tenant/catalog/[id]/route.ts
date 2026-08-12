import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { disableProduct, getOfferEconomics } from "@/lib/tenant/catalog";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const { id } = await params;
    const economics = await getOfferEconomics(ctx.tenantId, id);
    return json({ economics }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_WRITE_ROLES);
    const { id } = await params;
    const body = await req.json();
    if (body.action === "disable") {
      await disableProduct(ctx.tenantId, id);
      return json({ ok: true }, 200);
    }
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return errorResponse(err);
  }
}
