/**
 * Single Entitlement API.
 *   GET /api/tenant/connectivity/entitlements/[id] — get entitlement
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getEntitlement } from "@/lib/connectivity/entitlement";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const { id } = await params;
    const entitlement = await getEntitlement(id, ctx.tenantId);
    return json({ entitlement }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
