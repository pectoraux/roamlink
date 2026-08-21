/**
 * Protocol API — Actions
 * POST /api/v1/connectivity/actions
 *
 * Creates and optionally executes a connectivity action.
 *
 * Phase 12.3.6: Accepts API-key OR session auth. Canonical error envelope.
 * Phase 12.2: Verifies the session's entitlement belongs to the principal's tenant.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal, principalTenantId } from "@/lib/api/principal";
import { getRequestId, apiV1ErrorResponse, apiV1SuccessResponse } from "@/lib/api/protocol";
import { enforceRateLimit } from "@/lib/api/rate-limit-helper";
import { createAction, executeAction } from "@/lib/control-plane/action-executor";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "write");
    const tenantId = principalTenantId(principal);

    // Phase 12.4.6.2: Rate limit check (after auth, before handler logic).
    const rateLimitResult = await enforceRateLimit({
      tenantId,
      apiKeyId: principal.type === "api_key" ? principal.id : undefined,
      path: new URL(req.url).pathname,
    }, requestId);
    if (!rateLimitResult.allowed) return rateLimitResult.response!;

    const body = await req.json();
    const { sessionId, decisionId, type, targetResourceId, reason, policyVersion, execute } = body;

    if (!sessionId || !type) {
      throw new AppError("validation", "sessionId and type are required", 400, "sessionId and type are required.");
    }

    const validTypes = ["DISCOVER", "RESERVE", "ACTIVATE", "SWITCH", "SUSPEND", "RESUME", "RENEW", "RELEASE", "TRANSFER"];
    if (!validTypes.includes(type)) {
      throw new AppError("validation", `Invalid type. Valid: ${validTypes.join(", ")}`, 400, `Invalid action type. Valid types: ${validTypes.join(", ")}.`);
    }

    // Verify the session exists and belongs to this tenant via its entitlement.
    const session = await db.connectivitySession.findUnique({
      where: { id: sessionId },
      select: { subjectId: true, entitlementId: true },
    });
    if (!session) {
      throw new AppError("not_found", "Session not found", 404, "Session not found.");
    }
    // For session auth, the session's subjectId must match the authenticated user.
    if (principal.type === "session" && session.subjectId !== principal.userId) {
      throw new AppError("authorization", "Session does not belong to this user", 403, "Session does not belong to this user.");
    }
    // P0-6: tenantless sessions are rejected.
    if (!session.entitlementId) {
      throw new AppError("authorization", "Session has no entitlement — cannot establish tenant authority", 403, "Session has no entitlement — cannot establish tenant authority.");
    }
    const entitlement = await db.connectivityEntitlement.findUnique({
      where: { id: session.entitlementId },
      select: { tenantId: true },
    });
    if (!entitlement || entitlement.tenantId !== tenantId) {
      throw new AppError("authorization", "Session entitlement does not belong to this tenant", 403, "Session entitlement does not belong to this tenant.");
    }

    const action = await createAction({
      sessionId,
      decisionId,
      type,
      targetResourceId,
      reason,
      policyVersion,
    });

    // Optionally execute immediately
    let execution;
    if (execute) {
      execution = await executeAction(action.id);
    }

    return apiV1SuccessResponse({ action, execution }, requestId, 201);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
