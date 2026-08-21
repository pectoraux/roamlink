/**
 * Protocol API — Capabilities
 * GET  /api/v1/connectivity/capabilities — discover capabilities
 * POST /api/v1/connectivity/capabilities — advertise a capability
 *
 * Phase 12.3.6: Accepts API-key OR session auth. Canonical error envelope.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal, principalTenantId } from "@/lib/api/principal";
import { getRequestId, apiV1ErrorResponse, apiV1SuccessResponse } from "@/lib/api/protocol";
import { enforceRateLimit } from "@/lib/api/rate-limit-helper";
import { advertiseCapability, discoverCapabilities } from "@/lib/control-plane/capability-registry";
import { AppError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "read");
    const tenantId = principalTenantId(principal);

    // Phase 12.4.6.2: Rate limit check (after auth, before handler logic).
    const rateLimitResult = await enforceRateLimit({
      tenantId,
      apiKeyId: principal.type === "api_key" ? principal.id : undefined,
      path: new URL(req.url).pathname,
    }, requestId);
    if (!rateLimitResult.allowed) return rateLimitResult.response!;

    const { searchParams } = req.nextUrl;
    const type = searchParams.get("type") ?? undefined;
    const country = searchParams.get("country") ?? undefined;
    const city = searchParams.get("city") ?? undefined;
    const minReliability = searchParams.get("minReliability")
      ? parseFloat(searchParams.get("minReliability")!)
      : undefined;

    const capabilities = await discoverCapabilities({
      tenantId,
      type,
      country,
      city,
      minReliability,
    });

    return apiV1SuccessResponse({ capabilities }, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}

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
    const { providerInstanceId, type, providerType, bandwidth, latency, reliability, geographicCoverage, mobility, metering } = body;

    if (!providerInstanceId || !type || !providerType) {
      throw new AppError("validation", "providerInstanceId, type, and providerType are required", 400, "providerInstanceId, type, and providerType are required.");
    }

    const result = await advertiseCapability({
      tenantId,
      providerInstanceId,
      type,
      providerType,
      bandwidth,
      latency,
      reliability,
      geographicCoverage,
      mobility,
      metering,
    });

    return apiV1SuccessResponse({ capability: result }, requestId, 201);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
