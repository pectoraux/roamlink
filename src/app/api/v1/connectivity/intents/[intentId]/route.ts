/**
 * Phase 9.4 — Intent Detail API
 * GET    /api/v1/connectivity/intents/[intentId] — get intent history
 * POST   /api/v1/connectivity/intents/[intentId]/cancel — cancel intent
 * POST   /api/v1/connectivity/intents/[intentId]/supersede — create new version
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
import { getIntentHistory, cancelIntent, createIntent, emitIntentReevaluationEvent } from "@/lib/control-plane/intent-service";
import { AppError } from "@/lib/errors";

// GET — intent history
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
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

    const { intentId } = await params;
    const history = await getIntentHistory(user.id, intentId);

    return apiV1SuccessResponse({ intentId, history }, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}

// POST — supersede or cancel (based on body.action)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
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

    const { intentId } = await params;
    const body = await req.json();
    const { action, expectedVersion, rawText, capabilityType, desiredSpec, location, maxPriceMinor, mode, priority, expiresAt, deviceId, idempotencyKey } = body;

    if (action === "cancel") {
      const result = await cancelIntent(user.id, intentId, expectedVersion);
      if (result.rejected) {
        throw new AppError("conflict", `Intent rejected: ${result.rejected}`, 409, `Intent rejected: ${result.rejected}.`);
      }
      return apiV1SuccessResponse(result, requestId);
    }

    if (action === "supersede") {
      const result = await createIntent({
        subjectId: user.id,
        deviceId,
        rawText,
        capabilityType,
        desiredSpec,
        location,
        maxPriceMinor,
        mode,
        priority,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        supersedesIntentId: intentId,
        expectedVersion,
        idempotencyKey,
      });

      if (result.rejected) {
        const statusCode = result.rejected === "stale-version" ? 409 : 400;
        throw new AppError("conflict", `Intent rejected: ${result.rejected}`, statusCode, `Intent rejected: ${result.rejected}.`);
      }

      // Emit reevaluation signal
      await emitIntentReevaluationEvent(result.intentId, result.version, user.id);

      return apiV1SuccessResponse(result, requestId, 200);
    }

    throw new AppError("validation", "action must be 'cancel' or 'supersede'", 400, "action must be 'cancel' or 'supersede'.");
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
