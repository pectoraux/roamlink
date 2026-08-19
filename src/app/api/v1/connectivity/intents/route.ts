/**
 * Phase 9.4 — Intent API
 * POST /api/v1/connectivity/intents — create a new intent (or supersede)
 * GET  /api/v1/connectivity/intents — get current active intent
 *
 * The intent is a declarative request for an outcome. It is NOT a command.
 * Creating/updating an intent emits a reevaluation signal — it does NOT
 * directly invoke the action executor.
 *
 * Phase 12.3.6: Accepts API-key OR session auth. For API-key auth, requires
 * a `subjectId` in the body (the API key can act on behalf of any user in its
 * tenant). For session auth, uses the authenticated user's id.
 * Canonical error envelope.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal } from "@/lib/api/principal";
import { getRequestId, apiV1ErrorResponse, apiV1SuccessResponse } from "@/lib/api/protocol";
import { createIntent, getActiveIntent, emitIntentReevaluationEvent } from "@/lib/control-plane/intent-service";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "write");

    const body = await req.json();
    const { rawText, capabilityType, desiredSpec, location, maxPriceMinor, mode, priority, expiresAt, deviceId, supersedesIntentId, expectedVersion, source, idempotencyKey } = body;

    if (!rawText && !capabilityType && !desiredSpec && !location) {
      throw new AppError("validation", "At least one of rawText, capabilityType, desiredSpec, or location is required", 400, "At least one of rawText, capabilityType, desiredSpec, or location is required.");
    }

    // Resolve subjectId: session auth uses the authenticated user; API-key auth
    // requires a subjectId in the body (the API key acts on behalf of a user in its tenant).
    let subjectId: string;
    if (principal.type === "session") {
      subjectId = principal.userId;
    } else {
      const requestedSubject = body.subjectId;
      if (!requestedSubject) {
        throw new AppError("validation", "subjectId is required in the body for API-key access", 400, "Provide a subjectId in the request body.");
      }
      const subject = await db.tenantUser.findUnique({
        where: { tenantId_userId: { tenantId: principal.tenantId, userId: requestedSubject } },
        select: { userId: true },
      });
      if (!subject) {
        throw new AppError("not_found", "Subject not found in your tenant", 404, "Subject not found in your tenant.");
      }
      subjectId = subject.userId;
    }

    const result = await createIntent({
      subjectId,
      deviceId,
      rawText,
      capabilityType,
      desiredSpec,
      location,
      maxPriceMinor,
      mode,
      priority,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      source: source ?? "USER",
      supersedesIntentId,
      expectedVersion,
      idempotencyKey,
      // Phase 12.4.4c: Persist the originating request ID for causality tracing.
      sourceRequestId: requestId,
      sourceChannel: "api",
    });

    if (result.rejected) {
      const statusCode = result.rejected === "stale-version" || result.rejected === "concurrent-supersession" ? 409 : 400;
      throw new AppError("conflict", `Intent rejected: ${result.rejected}`, statusCode, `Intent rejected: ${result.rejected}.`);
    }

    // Emit reevaluation signal (does NOT directly invoke action executor)
    await emitIntentReevaluationEvent(result.intentId, result.version, subjectId);

    return apiV1SuccessResponse(result, requestId, result.version === 1 ? 201 : 200);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "read");

    let subjectId: string;
    if (principal.type === "session") {
      subjectId = principal.userId;
    } else {
      const requestedSubject = req.nextUrl.searchParams.get("subjectId");
      if (!requestedSubject) {
        throw new AppError("validation", "subjectId query param is required for API-key access", 400, "Provide a subjectId query parameter.");
      }
      const subject = await db.tenantUser.findUnique({
        where: { tenantId_userId: { tenantId: principal.tenantId, userId: requestedSubject } },
        select: { userId: true },
      });
      if (!subject) {
        throw new AppError("not_found", "Subject not found in your tenant", 404, "Subject not found in your tenant.");
      }
      subjectId = subject.userId;
    }

    const intent = await getActiveIntent(subjectId);
    if (!intent) {
      return apiV1SuccessResponse({ intent: null }, requestId);
    }

    return apiV1SuccessResponse({
      intent: {
        intentId: intent.intentId,
        version: intent.version,
        status: intent.status,
        payload: intent.payload,
        expiresAt: intent.expiresAt?.toISOString() ?? null,
        createdAt: intent.createdAt.toISOString(),
      },
    }, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
