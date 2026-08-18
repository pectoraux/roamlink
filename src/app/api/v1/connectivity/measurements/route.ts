/**
 * Protocol API — Measurements
 * POST /api/v1/connectivity/measurements
 *
 * Phase 8.6: records a measurement through the canonical ingestion path.
 * Phase 12.2: Verifies session/resource/providerInstance belong to tenant.
 * Phase 12.3.6: Accepts API-key OR session auth. Canonical error envelope.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal, principalTenantId } from "@/lib/api/principal";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import { ingestMeasurement, isValidSource } from "@/lib/control-plane/measurement-store";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "write");
    const tenantId = principalTenantId(principal);

    const body = await req.json();
    const { sessionId, resourceId, providerInstanceId, type, metrics, source, confidence, capturedAt } = body;

    if (!type || !["USAGE", "QUALITY", "AVAILABILITY"].includes(type)) {
      throw new AppError("validation", "type must be USAGE, QUALITY, or AVAILABILITY", 400, "type must be USAGE, QUALITY, or AVAILABILITY.");
    }

    if (!metrics || typeof metrics !== "object") {
      throw new AppError("validation", "metrics object is required", 400, "metrics object is required.");
    }

    const resolvedSource = source ?? "PROVIDER";
    if (!isValidSource(resolvedSource)) {
      throw new AppError(
        "validation",
        `Invalid source "${resolvedSource}"`,
        400,
        `Invalid source. Must be one of: ADAPTER, DEVICE, PROBE, PROVIDER, DERIVED.`,
      );
    }

    // Verify session belongs to this tenant.
    if (sessionId) {
      const session = await db.connectivitySession.findUnique({
        where: { id: sessionId },
        select: { subjectId: true, entitlementId: true },
      });
      if (!session) throw new AppError("not_found", "Session not found", 404, "Session not found.");
      if (principal.type === "session" && session.subjectId !== principal.userId) {
        throw new AppError("authorization", "Session does not belong to this user", 403, "Session does not belong to this user.");
      }
      if (session.entitlementId) {
        const ent = await db.connectivityEntitlement.findUnique({ where: { id: session.entitlementId }, select: { tenantId: true } });
        if (!ent || ent.tenantId !== tenantId) throw new AppError("authorization", "Session entitlement does not belong to this tenant", 403, "Session entitlement does not belong to this tenant.");
      }
    }

    // Verify providerInstance belongs to this tenant.
    if (providerInstanceId) {
      const instance = await db.connectivityProviderInstance.findUnique({ where: { id: providerInstanceId }, select: { tenantId: true } });
      if (!instance || instance.tenantId !== tenantId) throw new AppError("authorization", "Provider instance does not belong to this tenant", 403, "Provider instance does not belong to this tenant.");
    }

    // Verify resource belongs to this tenant (via capability.tenantId).
    if (resourceId) {
      const resource = await db.protocolResource.findUnique({ where: { id: resourceId }, select: { capabilityId: true } });
      if (resource) {
        const cap = await db.protocolCapability.findUnique({ where: { id: resource.capabilityId }, select: { tenantId: true } });
        if (!cap || cap.tenantId !== tenantId) throw new AppError("authorization", "Resource does not belong to this tenant", 403, "Resource does not belong to this tenant.");
      }
    }

    const result = await ingestMeasurement({
      sessionId,
      resourceId,
      providerInstanceId,
      type,
      metrics,
      source: resolvedSource,
      confidence,
      capturedAt: capturedAt ? new Date(capturedAt) : undefined,
    });

    return apiSuccessResponse({
      measurement: { id: result.measurementId },
      freshness: result.freshness,
      health: result.health,
      eventsEmitted: result.eventsEmitted,
    }, requestId, 201);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
