/**
 * Phase 12.3.3 — Canonical API error envelope + request correlation.
 *
 * This module establishes the external API protocol contract for errors.
 *
 * ENVELOPE
 * ========
 *
 *   {
 *     "error": {
 *       "code": "tenant_forbidden",
 *       "message": "The resource is outside your tenant.",
 *       "requestId": "req_abc123"
 *     }
 *   }
 *
 * The `code` is a STABLE, machine-readable string from a fixed taxonomy (below).
 * External clients MUST branch on `code`, never on `message` (which is human-
 * readable and may change wording between releases).
 *
 * CODE TAXONOMY
 * =============
 *
 *   auth_required          — no authentication credentials provided (401)
 *   auth_invalid           — credentials are wrong / key not found (401)
 *   auth_revoked           — API key / session has been revoked (401)
 *   auth_expired           — API key / session has expired (401)
 *   auth_malformed         — Authorization header is malformed (401)
 *   forbidden              — authenticated but not authorized for this action (403)
 *   tenant_forbidden       — cross-tenant access denied (403)
 *   scope_insufficient    — API key lacks required scope (403)
 *   not_found              — resource not found (404)
 *   validation_failed      — request body/params failed validation (400)
 *   conflict              — state conflict (e.g. duplicate, stale version) (409)
 *   idempotency_conflict   — same idempotency key reused with different payload (409)
 *   idempotency_in_progress — prior request with same key still processing (409)
 *   rate_limited           — too many requests (429)
 *   provider_error        — upstream provider failure (502)
 *   payment_failed        — payment declined / failed (402)
 *   provisioning_failed   — eSIM / connectivity provisioning failure (500)
 *   budget_exceeded       — spend budget exceeded (402)
 *   internal_error        — unhandled server error (500)
 *
 * REQUEST CORRELATION
 * ===================
 *
 * Every API response includes a `requestId`. It is either:
 *   - extracted from the incoming `x-request-id` header (caller-supplied), or
 *   - generated as `req_<cuid>` if absent.
 *
 * The `requestId` is returned in the response header `x-request-id` AND in the
 * error envelope's `error.requestId` field. Successful responses include it
 * in the `x-request-id` header only (the body is the caller's data).
 *
 * This enables end-to-end tracing: a client reporting an error includes the
 * requestId, and the server can correlate it to a specific request in logs.
 */

import { NextResponse } from "next/server";
import { AppError, safeErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { randomBytes } from "crypto";
import { CURRENT_API_VERSION } from "@/lib/api/version";

// ---------------------------------------------------------------------------
// Stable error code taxonomy
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "auth_required"
  | "auth_invalid"
  | "auth_revoked"
  | "auth_expired"
  | "auth_malformed"
  | "forbidden"
  | "tenant_forbidden"
  | "scope_insufficient"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "rate_limited"
  | "provider_error"
  | "payment_failed"
  | "provisioning_failed"
  | "budget_exceeded"
  | "internal_error";

/**
 * Map an internal AppError.errorClass + statusCode to a stable ApiErrorCode.
 * This is the canonical mapping — external clients branch on these codes.
 */
export function classifyError(errorClass: string, statusCode: number, message: string): ApiErrorCode {
  // Specific message-pattern matches first (these carry the most signal).
  const lower = message.toLowerCase();

  // Idempotency-specific
  if (lower.includes("idempotency") && lower.includes("different payload")) return "idempotency_conflict";
  if (lower.includes("idempotency") && lower.includes("in progress")) return "idempotency_in_progress";
  if (lower.includes("idempotency")) return "conflict";

  // Auth-specific
  if (errorClass === "auth") {
    if (lower.includes("revoked")) return "auth_revoked";
    if (lower.includes("expired")) return "auth_expired";
    if (lower.includes("malformed") || lower.includes("invalid format")) return "auth_malformed";
    if (lower.includes("no api key") || lower.includes("no authentication") || lower.includes("not authenticated") || lower.includes("no active session") || lower.includes("no auth")) return "auth_required";
    return "auth_invalid";
  }

  // Authorization-specific
  if (errorClass === "authorization") {
    if (lower.includes("scope")) return "scope_insufficient";
    if (lower.includes("tenant")) return "tenant_forbidden";
    return "forbidden";
  }

  // Status-code fallbacks
  if (statusCode === 401) return "auth_invalid";
  if (statusCode === 403) return "forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 400) return "validation_failed";
  if (statusCode === 402) {
    if (lower.includes("budget")) return "budget_exceeded";
    return "payment_failed";
  }
  if (statusCode === 409) return "conflict";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 502) return "provider_error";

  // Error-class fallbacks
  if (errorClass === "payment") return "payment_failed";
  if (errorClass === "provider") return "provider_error";
  if (errorClass === "provisioning") return "provisioning_failed";
  if (errorClass === "rate_limit") return "rate_limited";
  if (errorClass === "validation") return "validation_failed";
  if (errorClass === "not_found") return "not_found";
  if (errorClass === "conflict") return "conflict";

  return "internal_error";
}

// ---------------------------------------------------------------------------
// Request ID
// ---------------------------------------------------------------------------

export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PREFIX = "req_";

/**
 * Get the request ID from the incoming `x-request-id` header, or generate one.
 * The generated ID is `req_` + a 16-byte random hex string (collision-resistant).
 */
export function getRequestId(req?: Request): string {
  if (req) {
    const supplied = req.headers.get(REQUEST_ID_HEADER);
    if (supplied && supplied.length > 0 && supplied.length <= 128) {
      // Sanitize: allow only alphanumeric + underscore + hyphen.
      if (/^[a-zA-Z0-9_-]+$/.test(supplied)) {
        return supplied;
      }
    }
  }
  // Generate a fresh request ID.
  return REQUEST_ID_PREFIX + randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Canonical error envelope
// ---------------------------------------------------------------------------

export type ApiErrorEnvelope = {
  error: {
    code: ApiErrorCode;
    message: string;        // safe, human-readable
    requestId: string;
    details?: Record<string, unknown>;
  };
};

/**
 * Build a canonical API error response. This is the SINGLE function all API
 * routes should use to emit errors. It guarantees:
 *   - stable `code` from the taxonomy
 *   - safe `message` (never leaks internals)
 *   - `requestId` for correlation
 *   - `x-request-id` response header
 *   - structured logging with the requestId
 */
export function apiErrorResponse(
  err: unknown,
  requestId: string,
  options?: { statusCode?: number; details?: Record<string, unknown> },
): NextResponse {
  let code: ApiErrorCode;
  let message: string;
  let statusCode: number;
  let errorClass: string;
  let internalMessage: string;

  if (err instanceof AppError) {
    errorClass = err.errorClass;
    internalMessage = err.message;
    message = safeErrorMessage(err);
    statusCode = options?.statusCode ?? err.statusCode;
    // Classify using both the internal message and the safe message — the
    // safe message often carries the canonical phrasing (e.g. "invalid format")
    // while the internal message carries the specifics (e.g. "invalid prefix").
    code = classifyError(err.errorClass, statusCode, internalMessage + " " + message);
  } else {
    // Unhandled error — never leak internals.
    errorClass = "internal";
    internalMessage = err instanceof Error ? err.message : String(err);
    message = "Something went wrong. Please try again.";
    statusCode = options?.statusCode ?? 500;
    code = "internal_error";
  }

  const body: ApiErrorEnvelope = {
    error: {
      code,
      message,
      requestId,
      ...(options?.details ? { details: options.details } : {}),
    },
  };

  // Structured log with requestId for server-side correlation.
  if (statusCode >= 500) {
    logger.error("api.error", {
      requestId,
      code,
      errorClass,
      statusCode,
      message: internalMessage,
    });
  } else if (statusCode >= 400) {
    logger.warn("api.client_error", {
      requestId,
      code,
      errorClass,
      statusCode,
    });
  }

  return NextResponse.json(body, {
    status: statusCode,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

/**
 * Build a canonical success response with the `x-request-id` header.
 * The body is the caller's data (no envelope wrapper for success).
 */
export function apiSuccessResponse(data: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

/**
 * Phase 12.3.5: Build a canonical v1 success response that ALWAYS carries the
 * version contract headers (X-API-Version + X-API-Stable) in addition to the
 * x-request-id header. This is the canonical success response for ALL /api/v1/*
 * routes — it prevents routes from accidentally omitting the version headers.
 *
 * Every /api/v1/* route MUST use this helper (or apiV1ErrorResponse) instead
 * of the plain apiSuccessResponse/apiErrorResponse, so the version contract is
 * enforced at the response boundary.
 */
export function apiV1SuccessResponse(data: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      "X-API-Version": String(CURRENT_API_VERSION),
      "X-API-Stable": "true",
    },
  });
}

/**
 * Phase 12.3.5: Build a canonical v1 error response that ALWAYS carries the
 * version contract headers. This is the canonical error response for ALL
 * /api/v1/* routes.
 */
export function apiV1ErrorResponse(
  err: unknown,
  requestId: string,
  options?: { statusCode?: number; details?: Record<string, unknown> },
): NextResponse {
  const res = apiErrorResponse(err, requestId, options);
  // Attach the version contract headers to the error response.
  res.headers.set("X-API-Version", String(CURRENT_API_VERSION));
  res.headers.set("X-API-Stable", "true");
  return res;
}
