/**
 * Phase 12.4.4 — Operational Observability Endpoint.
 * GET /api/internal/ops — returns the operational state summary.
 *
 * This endpoint is for operators (not external API consumers). It provides
 * a real-time view of the platform's operational state:
 *   - Idempotency operations by state (IN_PROGRESS, COMPLETED, FAILED, RECONCILIATION_*)
 *   - Connectivity sessions by state
 *   - Provider resource bindings by state
 *   - Pending reevaluation events
 *   - Expired leases (crashed workers needing reclaim)
 *
 * Auth: CRON_SECRET (same as the reconciliation cron endpoint).
 */

import { NextRequest } from "next/server";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import { getOperationalStateSummary } from "@/lib/observability/provider-correlation";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    // Auth: require CRON_SECRET (operator-only, not public API).
    const authHeader = req.headers.get("authorization");
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return apiErrorResponse(new Error("CRON_SECRET not configured"), requestId);
    }
    if (authHeader !== `Bearer ${secret}`) {
      return apiErrorResponse(new Error("Unauthorized"), requestId);
    }

    const summary = await getOperationalStateSummary();
    return apiSuccessResponse(summary, requestId);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
