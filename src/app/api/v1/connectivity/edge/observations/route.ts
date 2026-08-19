/**
 * Phase 9.1 — Edge Observation Upload
 * POST /api/v1/connectivity/edge/observations
 *
 * Accepts a batch of connectivity observations from a mobile device. The
 * server:
 *   1. Authenticates the user (session cookie)
 *   2. Validates device ownership (deviceId → user)
 *   3. Dedupes by observationId + (deviceId, sequence)
 *   4. Persists immutable EdgeObservationRecord
 *   5. Projects to ConnectivityMeasurement (source=DEVICE)
 *   6. Emits MEASUREMENT_RECEIVED (existing reevaluation path)
 *
 * The device NEVER submits health/decisions. The server derives everything.
 * Device-supplied resourceId is a HINT — validated against the session's
 * active resource.
 *
 * Phase 12.3.5: Uses the canonical v1 response helpers so the X-API-Version
 * + X-API-Stable headers are enforced at the response boundary. Errors are
 * thrown as AppError so the catch handler emits the canonical envelope.
 */

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRequestId, apiV1SuccessResponse, apiV1ErrorResponse } from "@/lib/api/protocol";
import { ingestEdgeObservationBatch } from "@/lib/control-plane/edge-ingestion";
import { AppError } from "@/lib/errors";
import type { EdgeObservationBatch } from "@roamlink/shared";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "No active session — authentication required", 401, "Authentication required.");

    const body = await req.json();
    const { deviceId, observations } = body;

    if (!deviceId || typeof deviceId !== "string") {
      throw new AppError("validation", "deviceId is required", 400, "deviceId is required.");
    }
    if (!Array.isArray(observations) || observations.length === 0) {
      throw new AppError("validation", "observations array is required", 400, "observations array is required.");
    }
    if (observations.length > 100) {
      throw new AppError("validation", "max 100 observations per batch", 413, "max 100 observations per batch.");
    }

    let ack;
    try {
      ack = await ingestEdgeObservationBatch(user.id, { deviceId, observations } as EdgeObservationBatch);
    } catch (err) {
      // Preserve the prior classification: ownership / impersonation errors
      // are 403; other ingestion failures are 400. ingestEdgeObservationBatch
      // throws plain Errors with these semantics in their messages.
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : "ingestion failed";
      const isOwnershipError = message.includes("ownership") || message.includes("impersonation");
      throw new AppError(
        isOwnershipError ? "authorization" : "validation",
        message,
        isOwnershipError ? 403 : 400,
        isOwnershipError ? "Device ownership mismatch." : "Observation ingestion failed.",
      );
    }
    return apiV1SuccessResponse(ack, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
