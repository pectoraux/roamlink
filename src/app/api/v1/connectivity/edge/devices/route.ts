/**
 * Phase 9.1 — Edge Device Registration
 * POST /api/v1/connectivity/edge/devices
 *
 * Binds a client-generated deviceId to the authenticated user. Subsequent
 * observations from this deviceId are validated against this ownership.
 *
 * Phase 12.3.5: Uses the canonical v1 response helpers so the X-API-Version
 * + X-API-Stable headers are enforced at the response boundary. Errors are
 * thrown as AppError so the catch handler emits the canonical envelope.
 */

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRequestId, apiV1SuccessResponse, apiV1ErrorResponse } from "@/lib/api/protocol";
import { enforceRateLimit } from "@/lib/api/rate-limit-helper";
import { requireTenantContext } from "@/lib/tenant/context";
import { registerEdgeDevice } from "@/lib/control-plane/edge-ingestion";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "No active session — authentication required", 401, "Authentication required.");

    // Phase 12.4.6.2: Resolve tenant context for rate limiting (after auth).
    const tenantCtx = await requireTenantContext(user);
    const rateLimitResult = await enforceRateLimit({
      tenantId: tenantCtx.tenantId,
      path: new URL(req.url).pathname,
    }, requestId);
    if (!rateLimitResult.allowed) return rateLimitResult.response!;

    const body = await req.json();
    const { deviceId, platform, appVersion } = body;

    if (!deviceId || typeof deviceId !== "string") {
      throw new AppError("validation", "deviceId is required", 400, "deviceId is required.");
    }
    if (!platform || !["ios", "android", "web", "unknown"].includes(platform)) {
      throw new AppError("validation", "platform must be ios|android|web|unknown", 400, "platform must be ios|android|web|unknown.");
    }
    if (!appVersion || typeof appVersion !== "string") {
      throw new AppError("validation", "appVersion is required", 400, "appVersion is required.");
    }

    const result = await registerEdgeDevice({ userId: user.id, deviceId, platform, appVersion });
    return apiV1SuccessResponse(result, requestId, result.registered ? 201 : 200);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
