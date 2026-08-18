/**
 * API route helpers — consistent JSON responses + error handling.
 *
 * Phase 12.3.3: errorResponse() now emits the canonical API error envelope:
 *   { error: { code, message, requestId } }
 * with a stable code taxonomy and `x-request-id` header. See lib/api/protocol.ts.
 *
 * For routes that want full control over the requestId (e.g. extracting it
 * from the incoming request), import apiErrorResponse from lib/api/protocol
 * directly and pass the requestId.
 */

import { NextResponse } from "next/server";
import { apiErrorResponse, getRequestId } from "@/lib/api/protocol";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * Canonical error response. Emits:
 *   { error: { code, message, requestId } }
 * with the `x-request-id` response header.
 *
 * If no requestId is supplied, one is generated. For routes with access to the
 * incoming Request, prefer passing `getRequestId(req)` to correlate the
 * response to the caller's request ID.
 */
export function errorResponse(err: unknown, status?: number, requestId?: string) {
  return apiErrorResponse(err, requestId ?? getRequestId(), { statusCode: status });
}

export { getClientIP } from "./api/request";
