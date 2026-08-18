/**
 * Resource Binding Transition API.
 *   POST /api/tenant/connectivity/entitlements/[id]/bindings/[bindingId] — transition binding state
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES } from "@/lib/tenant/context";
import { transitionBinding, BINDING_STATES } from "@/lib/connectivity/entitlement";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; bindingId: string }> }) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);
    const { id, bindingId } = await params;

    const body = await req.json();
    const { toState, providerResourceId, providerMetadata, provisioningState, reason } = body;

    if (!toState) {
      return json({ error: "toState is required" }, 400);
    }

    // Validate the target state is a known binding state
    const validStates = Object.values(BINDING_STATES);
    if (!validStates.includes(toState)) {
      return json({ error: `Invalid toState. Valid states: ${validStates.join(", ")}` }, 400);
    }

    const result = await transitionBinding({
      bindingId,
      toState,
      providerResourceId,
      providerMetadata,
      provisioningState,
      reason,
      userId: user.id,
      tenantId: ctx.tenantId, // Phase 12.2: ownership verification
    });

    return json(result, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
