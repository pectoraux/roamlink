import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getTenantCustomer, updateTenantCustomer } from "@/lib/tenant/customers";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const { id } = await params;
    const customer = await getTenantCustomer(ctx.tenantId, id);
    return json({ customer }, 200);
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
    const { name, phone, status, metadata } = body;
    await updateTenantCustomer(ctx.tenantId, id, { name, phone, status, metadata });
    return json({ ok: true }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
