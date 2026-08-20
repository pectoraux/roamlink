/**
 * Phase 12.4.6.2 — Rate limit middleware for v1 API routes.
 *
 * Wraps a v1 route handler with DB-authoritative rate limiting.
 * If the rate limit is exceeded, returns 429 with the canonical error envelope.
 *
 * Usage:
 *   export const GET = withRateLimit(async (req) => { ... });
 *   export const POST = withRateLimit(async (req) => { ... });
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveApiPrincipal, principalTenantId } from "@/lib/api/principal";
import { getRequestId, apiV1ErrorResponse, apiV1SuccessResponse } from "@/lib/api/protocol";
import { checkRateLimit, rateLimitHeaders, type RateLimitIdentity } from "@/lib/api/rate-limit";
import { AppError } from "@/lib/errors";

/**
 * Wrap a v1 route handler with rate limiting.
 * The principal is resolved first (for tenant/key identity), then the rate
 * limit is checked. If the limit is exceeded, a 429 response is returned
 * with the canonical error envelope and rate limit headers.
 */
export function withRateLimit<T>(
  handler: (req: NextRequest) => Promise<NextResponse<T>>,
): (req: NextRequest) => Promise<NextResponse<T>> {
  return async (req: NextRequest) => {
    const requestId = getRequestId(req);

    // Resolve the principal to get tenantId + apiKeyId for rate limiting.
    // If auth fails, the handler will handle it (rate limiting is applied
    // AFTER auth — unauthenticated requests don't consume the rate limit).
    let identity: RateLimitIdentity | null = null;
    try {
      const principal = await resolveApiPrincipal(req, "read");
      identity = {
        tenantId: principalTenantId(principal),
        apiKeyId: principal.type === "api_key" ? principal.id : undefined,
        path: new URL(req.url).pathname,
      };
    } catch {
      // Auth failed — let the handler handle it (no rate limiting applied).
      return handler(req);
    }

    // Check the rate limit.
    const result = await checkRateLimit(identity);

    if (!result.allowed) {
      // Rate limit exceeded — return 429.
      const errorResponse = apiV1ErrorResponse(
        new AppError(
          "rate_limit",
          `Rate limit exceeded. Limit: ${result.limit} requests per minute. Scope: ${result.scope}. Retry after ${Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)}s.`,
          429,
          "Rate limit exceeded. Please retry later.",
        ),
        requestId,
      );

      // Attach rate limit headers.
      const headers = rateLimitHeaders(result);
      for (const [key, value] of Object.entries(headers)) {
        errorResponse.headers.set(key, value);
      }

      return errorResponse as NextResponse<T>;
    }

    // Rate limit passed — run the handler and attach rate limit headers.
    const response = await handler(req);
    const headers = rateLimitHeaders(result);
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }

    return response;
  };
}
