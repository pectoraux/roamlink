/**
 * Protocol API — Sessions
 * GET  /api/v1/connectivity/sessions — list sessions (tenant-scoped)
 * POST /api/v1/connectivity/sessions — create a session
 *
 * Phase 12.3.6: Now accepts EITHER API-key OR session auth (resolveApiPrincipal).
 * The principal's tenantId is authoritative — caller cannot override it.
 * Errors use the canonical API envelope ({ error: { code, message, requestId } }).
 *
 * Phase 12.2 P0-5: GET constrains the tenant AT THE DATABASE QUERY LEVEL via
 * the entitlement relation filter, BEFORE take. No post-fetch filtering.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal, principalTenantId } from "@/lib/api/principal";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import { createSession } from "@/lib/control-plane/session-manager";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "read");
    const tenantId = principalTenantId(principal);

    // For session auth, sessions are scoped to the user. For API-key auth,
    // sessions are scoped to the tenant (the API key can see all sessions
    // in its tenant). We use the principal's identity to scope appropriately.
    const subjectId = principal.type === "session" ? principal.userId : undefined;

    // Phase 12.2 P0-5: Tenant ownership is part of the database query itself,
    // via the entitlement relation. The tenant filter is applied BEFORE take.
    const sessions = await db.connectivitySession.findMany({
      where: {
        ...(subjectId ? { subjectId } : {}),
        entitlement: {
          tenantId,
          ...(subjectId ? { userId: subjectId } : {}),
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        measurements: { orderBy: { capturedAt: "desc" }, take: 5 },
        actions: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });

    return apiSuccessResponse({ sessions }, requestId);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "write");
    const tenantId = principalTenantId(principal);
    const userId = principal.type === "session" ? principal.userId : null;

    const body = await req.json();
    const { intentId, entitlementId, policyId } = body;

    if (!entitlementId) {
      throw new AppError("validation", "entitlementId is required for tenant-scoped session creation", 400, "entitlementId is required.");
    }
    const entitlement = await db.connectivityEntitlement.findUnique({
      where: { id: entitlementId },
      select: { tenantId: true, userId: true },
    });
    if (!entitlement) {
      throw new AppError("not_found", "Entitlement not found", 404, "Entitlement not found.");
    }
    if (entitlement.tenantId !== tenantId) {
      throw new AppError("authorization", "Entitlement does not belong to this tenant", 403, "Entitlement does not belong to this tenant.");
    }
    // For session auth, also verify the entitlement belongs to the user.
    if (userId && entitlement.userId !== userId) {
      throw new AppError("authorization", "Entitlement does not belong to this user", 403, "Entitlement does not belong to this user.");
    }

    const session = await createSession({
      subjectId: userId ?? entitlement.userId!,
      intentId,
      entitlementId,
      policyId,
    });

    return apiSuccessResponse({ session }, requestId, 201);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
