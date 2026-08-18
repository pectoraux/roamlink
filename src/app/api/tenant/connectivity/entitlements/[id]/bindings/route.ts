/**
 * Resource Bindings API.
 *   GET  /api/tenant/connectivity/entitlements/[id]/bindings — list bindings
 *   POST /api/tenant/connectivity/entitlements/[id]/bindings — create binding
 *
 * Phase 12.2: ctx.tenantId is passed to all service calls for ownership verification.
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { createResourceBinding, listResourceBindings } from "@/lib/connectivity/entitlement";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const { id } = await params;
    const bindings = await listResourceBindings(id, ctx.tenantId);
    return json({ bindings }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);
    const { id } = await params;

    const body = await req.json();
    const { providerType, providerMetadata } = body;

    if (!providerType) {
      return json({ error: "providerType is required" }, 400);
    }

    const result = await createResourceBinding({
      entitlementId: id,
      providerType,
      providerMetadata,
      userId: user.id,
      tenantId: ctx.tenantId, // Phase 12.2: ownership verification
    });

    return json(result, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
