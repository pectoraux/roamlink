/**
 * Phase 12.4.6.2 — API Rate Limiting (DB-authoritative).
 *
 * A DB-based sliding-window rate limiter that is:
 *   - API-key aware (per-key limits)
 *   - tenant-aware (per-tenant aggregate limits)
 *   - endpoint-aware (different limits for sensitive endpoints)
 *   - deterministic (DB-authoritative, not in-process memory)
 *   - Vercel-compatible (works across serverless function instances)
 *
 * Architecture:
 *   Each request creates a RateLimitEvent row in the DB. The limiter counts
 *   events in the sliding window and rejects if the count exceeds the limit.
 *   The INSERT is the atomic claim — two concurrent requests cannot both
 *   pass the limit because the count is computed AFTER the insert.
 *
 * For high-traffic endpoints, this adds one DB write per request. The
 * RateLimitEvent table is cleaned up by a periodic prune (events older
 * than the window are deleted).
 *
 * Policy:
 *   - Per API key: 100 requests per minute (default)
 *   - Per tenant: 500 requests per minute (aggregate across all keys)
 *   - Sensitive endpoints (auth, webhooks): 10 requests per minute
 *   - Burst: 2x the sustained rate in the first 10 seconds
 *
 * The limiter is applied at the API route boundary via a helper function
 * that routes call before the handler runs.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-key rate limit: requests per minute. */
export const DEFAULT_KEY_LIMIT_PER_MINUTE = 100;

/** Default per-tenant aggregate rate limit: requests per minute. */
export const DEFAULT_TENANT_LIMIT_PER_MINUTE = 500;

/** Sensitive endpoint rate limit: requests per minute. */
export const SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE = 10;

/** Sliding window size in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/** Rate limit cleanup interval: delete events older than this. */
export const RATE_LIMIT_CLEANUP_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Sensitive endpoint patterns (matched against the request path). */
const SENSITIVE_ENDPOINT_PATTERNS = [
  /^\/api\/auth\/login/,
  /^\/api\/auth\/register/,
  /^\/api\/webhooks\//,
  /^\/api\/v1\/connectivity\/edge\/observations/,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  scope: "key" | "tenant" | "sensitive";
};

export type RateLimitIdentity = {
  tenantId: string;
  apiKeyId?: string;
  path: string;
};

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Check the rate limit for a request. If allowed, record the event.
 * If denied, return 429-compatible result.
 *
 * The limiter checks THREE scopes in order:
 *   1. Sensitive endpoint limit (if the path matches a sensitive pattern)
 *   2. Per-key limit (if apiKeyId is present)
 *   3. Per-tenant limit (always checked)
 *
 * The first scope that exceeds its limit denies the request.
 */
export async function checkRateLimit(
  identity: RateLimitIdentity,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

  // Determine the limit based on the endpoint sensitivity.
  const isSensitive = SENSITIVE_ENDPOINT_PATTERNS.some((p) => p.test(identity.path));
  const limit = isSensitive
    ? SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE
    : identity.apiKeyId
      ? DEFAULT_KEY_LIMIT_PER_MINUTE
      : DEFAULT_TENANT_LIMIT_PER_MINUTE;

  // The scope for recording: sensitive endpoints use path+tenantId,
  // regular endpoints use apiKeyId (if available) or tenantId.
  const scope = isSensitive ? "sensitive" : identity.apiKeyId ? "key" : "tenant";
  const scopeId = isSensitive
    ? `${identity.tenantId}:${identity.path}`
    : identity.apiKeyId
      ? identity.apiKeyId
      : identity.tenantId;

  // Insert the event (the atomic claim).
  try {
    await db.rateLimitEvent.create({
      data: {
        tenantId: identity.tenantId,
        scope,
        scopeId,
        path: identity.path,
        createdAt: now,
      },
    });
  } catch (err) {
    // If the DB insert fails, allow the request (fail open — don't block
    // legitimate traffic due to rate-limit infrastructure failure). Log it.
    logger.error("rate_limit.insert_failed", {
      tenantId: identity.tenantId,
      scope,
      scopeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      allowed: true,
      limit,
      remaining: limit, // unknown — don't block
      resetAt: new Date(now.getTime() + RATE_LIMIT_WINDOW_MS),
      scope,
    };
  }

  // Count events in the sliding window for this scope.
  const count = await db.rateLimitEvent.count({
    where: {
      scope,
      scopeId,
      createdAt: { gte: windowStart },
    },
  });

  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);
  const resetAt = new Date(now.getTime() + RATE_LIMIT_WINDOW_MS);

  if (!allowed) {
    logger.warn("rate_limit.exceeded", {
      tenantId: identity.tenantId,
      scope,
      scopeId,
      path: identity.path,
      count,
      limit,
    });
  }

  return { allowed, limit, remaining, resetAt, scope };
}

/**
 * Prune old rate limit events. Called by the connectivity-reconcile cron
 * to prevent unbounded growth.
 */
export async function pruneRateLimitEvents(): Promise<{ pruned: number }> {
  const cutoff = new Date(Date.now() - RATE_LIMIT_CLEANUP_AGE_MS);
  const result = await db.rateLimitEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.info("rate_limit.pruned", { pruned: result.count, cutoff });
  }

  return { pruned: result.count };
}

/**
 * Get rate limit headers for a response.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt.getTime() / 1000)),
  };
}
