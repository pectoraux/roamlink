/**
 * Connectivity Entitlements API.
 *   GET  /api/tenant/connectivity/entitlements — list entitlements
 *   POST /api/tenant/connectivity/entitlements — create entitlement
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { createEntitlement, listEntitlements, seedConnectivityCapabilities } from "@/lib/connectivity/entitlement";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const entitlements = await listEntitlements(ctx.tenantId);
    return json({ entitlements }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);

    // Ensure capabilities exist
    await seedConnectivityCapabilities();

    const body = await req.json();
    const { subscriptionId, capabilityType, capabilitySet, policy, validFrom, validUntil } = body;

    if (!subscriptionId || !capabilityType || !capabilitySet) {
      return json({ error: "subscriptionId, capabilityType, and capabilitySet are required" }, 400);
    }

    const result = await createEntitlement({
      tenantId: ctx.tenantId,
      userId: user.id,
      subscriptionId,
      capabilityType,
      capabilitySet,
      policy,
      validFrom: validFrom ? new Date(validFrom) : new Date(),
      validUntil: validUntil ? new Date(validUntil) : undefined,
    });

    return json(result, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
