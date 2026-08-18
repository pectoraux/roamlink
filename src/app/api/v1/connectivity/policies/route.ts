/**
 * Protocol API — Policies
 * GET  /api/v1/connectivity/policies — get current user's policy
 * POST /api/v1/connectivity/policies — create/update policy
 *
 * Phase 12.3.6: Accepts API-key OR session auth. For API-key auth, requires
 * subjectId (query for GET, body for POST). Canonical error envelope.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal } from "@/lib/api/principal";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import { createOrUpdatePolicy, getPolicy, POLICY_PRESETS } from "@/lib/control-plane/policy-engine";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

async function resolveSubjectId(
  principal: Awaited<ReturnType<typeof resolveApiPrincipal>>,
  subjectParam: string | null | undefined,
): Promise<string> {
  if (principal.type === "session") return principal.userId;
  if (!subjectParam) {
    throw new AppError("validation", "subjectId is required for API-key access", 400, "Provide a subjectId.");
  }
  const subject = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId: principal.tenantId, userId: subjectParam } },
    select: { userId: true },
  });
  if (!subject) {
    throw new AppError("not_found", "Subject not found in your tenant", 404, "Subject not found in your tenant.");
  }
  return subject.userId;
}

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "read");
    const subjectId = await resolveSubjectId(principal, req.nextUrl.searchParams.get("subjectId"));

    const policy = await getPolicy(subjectId);
    return apiSuccessResponse({ policy, availablePresets: Object.keys(POLICY_PRESETS) }, requestId);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "write");
    const body = await req.json();
    const subjectId = await resolveSubjectId(principal, body.subjectId);

    const { preset, mode, maxAutoSpendMinor, preferredTransports, minReliability, switchHysteresis, requireUserApprovalForPurchase, neverInterruptActiveCall } = body;

    const result = await createOrUpdatePolicy({
      subjectId,
      preset,
      mode,
      maxAutoSpendMinor,
      preferredTransports,
      minReliability,
      switchHysteresis,
      requireUserApprovalForPurchase,
      neverInterruptActiveCall,
    });

    return apiSuccessResponse({ policy: result }, requestId, 201);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
