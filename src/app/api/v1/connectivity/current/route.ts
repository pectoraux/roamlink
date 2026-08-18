/**
 * Phase 9.2 — Current Connectivity (read-only)
 * GET /api/v1/connectivity/current
 *
 * Returns a read-only projection of the user's current connectivity state.
 * The mobile UI consumes this to display state — it has NO control-plane
 * authority. The server remains authoritative.
 *
 * Phase 12.3.6: Accepts API-key OR session auth. For API-key auth, requires
 * a `subjectId` query param (the API key can inspect any user in its tenant).
 * For session auth, uses the authenticated user's id (cannot be overridden).
 *
 * Canonical error envelope.
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal } from "@/lib/api/principal";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import { getCurrentConnectivityForUser } from "@/lib/control-plane/current-connectivity";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const principal = await resolveApiPrincipal(req, "read");

    // For session auth, scope to the authenticated user (cannot be overridden).
    // For API-key auth, scope to the subjectId query param (the API key can
    // inspect any user in its tenant — but the user must belong to the key's tenant).
    let subjectId: string;
    if (principal.type === "session") {
      subjectId = principal.userId;
    } else {
      const requestedSubject = req.nextUrl.searchParams.get("subjectId");
      if (!requestedSubject) {
        throw new AppError("validation", "subjectId query param is required for API-key access", 400, "Provide a subjectId query parameter.");
      }
      // Verify the subject belongs to the API key's tenant.
      const subject = await db.tenantUser.findUnique({
        where: { tenantId_userId: { tenantId: principal.tenantId, userId: requestedSubject } },
        select: { userId: true },
      });
      if (!subject) {
        throw new AppError("not_found", "Subject not found in your tenant", 404, "Subject not found in your tenant.");
      }
      subjectId = subject.userId;
    }

    const current = await getCurrentConnectivityForUser(subjectId);
    return apiSuccessResponse(current, requestId);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
