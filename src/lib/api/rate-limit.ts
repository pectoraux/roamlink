/**
 * Phase 12.4.6.1 — API Rate Limiting (DB-authoritative, atomic counter).
 *
 * A DB-based fixed-window rate limiter that is:
 *   - API-key aware (per-key limits)
 *   - tenant-aware (per-tenant aggregate limits — ALWAYS enforced)
 *   - endpoint-aware (sensitive endpoints have additional limits)
 *   - atomic (conditional UPDATE on a counter row — no INSERT-then-COUNT race)
 *   - Vercel-compatible (works across serverless function instances)
 *
 * Architecture:
 *   Uses a counter-table approach: each (scope, scopeId, windowKey) has a
 *   counter row. The limiter performs a conditional UPDATE:
 *
 *     UPDATE RateLimitCounter
 *     SET count = count + 1
 *     WHERE scope = ? AND scopeId = ? AND windowKey = ?
 *       AND count < limit
 *
 *   If affectedRows > 0, the request is allowed (the counter was incremented).
 *   If affectedRows = 0, the request is denied (limit reached or row doesn't exist yet).
 *   If the row doesn't exist, a new row is created with count=1 (if it doesn't
 *   already exist — INSERT ... ON CONFLICT DO NOTHING, then retry the UPDATE).
 *
 *   This is DB-authoritative: two concurrent requests cannot both increment
 *   past the limit because the conditional WHERE clause is evaluated atomically
 *   by the database. On PostgreSQL, this uses row-level locking (the UPDATE
 *   takes an exclusive lock on the row). On SQLite, SERIALIZABLE isolation
 *   provides the same guarantee.
 *
 * Quota model:
 *   For each request, ALL applicable scopes are checked:
 *     1. key scope (if apiKeyId present) — DEFAULT_KEY_LIMIT_PER_MINUTE
 *     2. tenant scope (ALWAYS) — DEFAULT_TENANT_LIMIT_PER_MINUTE
 *     3. sensitive scope (if path matches sensitive pattern) — SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE
 *
 *   A request is allowed ONLY if ALL applicable scopes pass.
 *   If any scope fails, the request is denied.
 *
 *   IMPORTANT: If a scope passes (counter incremented) but a later scope fails,
 *   the earlier increments are NOT rolled back. This is acceptable because:
 *     - The over-count is at most 1 per failed request per scope
 *     - The window resets every minute
 *     - The alternative (transactional multi-scope check) would require
 *       a distributed lock or serializable transaction, which is too expensive
 *       for per-request rate limiting
 *
 * Policy:
 *   - Per API key: 100 requests per minute (default)
 *   - Per tenant: 500 requests per minute (aggregate across ALL keys + sessions)
 *   - Sensitive endpoints (auth, webhooks, edge observations): 10 requests per minute
 *
 * Failure policy:
 *   - Non-sensitive endpoints: fail-open (allow on DB failure — don't block legitimate traffic)
 *   - Sensitive endpoints: fail-closed (deny on DB failure — security over availability)
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// Phase 12.4.6.3.1 — Configurable limits (dependency injection).
//
// Production deployments DO NOT set the RATE_LIMIT_* env vars — the defaults
// below (100 / 500 / 10) are used. This is the canonical production policy.
//
// Tests override these via env vars (e.g. RATE_LIMIT_KEY_PER_MINUTE=5) so the
// same DB-authoritative semantics can be proven with a small number of
// requests instead of 100+. The conditional-updateMany primitive is identical
// regardless of the limit value — only the threshold differs.
//
// This is dependency injection via environment, NOT a hardcoded production
// change: production behavior is unchanged when the env vars are absent.

/** Default per-key rate limit: requests per minute. (Production default.) */
export const DEFAULT_KEY_LIMIT_PER_MINUTE = 100;

/** Default per-tenant aggregate rate limit: requests per minute. (Production default.) */
export const DEFAULT_TENANT_LIMIT_PER_MINUTE = 500;

/** Sensitive endpoint rate limit: requests per minute. (Production default.) */
export const SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE = 10;

/**
 * Effective per-key limit. Reads RATE_LIMIT_KEY_PER_MINUTE at call time so
 * tests can override per-file. Falls back to the production default.
 */
export function getKeyLimitPerMinute(): number {
  const v = process.env.RATE_LIMIT_KEY_PER_MINUTE;
  if (!v) return DEFAULT_KEY_LIMIT_PER_MINUTE;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_KEY_LIMIT_PER_MINUTE;
}

/**
 * Effective per-tenant aggregate limit. Reads RATE_LIMIT_TENANT_PER_MINUTE at
 * call time so tests can override. Falls back to the production default.
 */
export function getTenantLimitPerMinute(): number {
  const v = process.env.RATE_LIMIT_TENANT_PER_MINUTE;
  if (!v) return DEFAULT_TENANT_LIMIT_PER_MINUTE;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TENANT_LIMIT_PER_MINUTE;
}

/**
 * Effective sensitive-endpoint limit. Reads RATE_LIMIT_SENSITIVE_PER_MINUTE at
 * call time so tests can override. Falls back to the production default.
 */
export function getSensitiveLimitPerMinute(): number {
  const v = process.env.RATE_LIMIT_SENSITIVE_PER_MINUTE;
  if (!v) return SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE;
}

/** Fixed window size in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/** Rate limit cleanup interval: delete counters older than this. */
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
  scope: string; // the scope that denied the request (or the strictest scope that passed)
  deniedScope?: string; // the scope that denied (if denied)
};

export type RateLimitIdentity = {
  tenantId: string;
  apiKeyId?: string;
  path: string;
};

type ScopeCheck = {
  scope: string;
  scopeId: string;
  limit: number;
};

// ---------------------------------------------------------------------------
// Window key
// ---------------------------------------------------------------------------

/**
 * Compute the fixed-window key for the current time.
 * Returns a string like "2024-01-15T10:23" (minute-granularity).
 * All requests within the same minute share the same window key.
 */
function windowKey(now: Date = new Date()): string {
  const iso = now.toISOString();
  return iso.slice(0, 16); // "2024-01-15T10:23"
}

/**
 * Compute when the current window resets (start of the next minute).
 */
function windowResetAt(now: Date = new Date()): Date {
  const reset = new Date(now);
  reset.setSeconds(0, 0);
  reset.setMinutes(reset.getMinutes() + 1);
  return reset;
}

// ---------------------------------------------------------------------------
// Atomic counter increment
// ---------------------------------------------------------------------------

/**
 * Atomically increment a rate-limit counter if it hasn't exceeded the limit.
 *
 * Uses a conditional UPDATE with WHERE count < limit:
 *   1. Try to UPDATE (increment count WHERE count < limit)
 *   2. If 0 rows affected, the row may not exist yet → try to INSERT
 *   3. If INSERT conflicts (row was created by another request), retry the UPDATE
 *   4. If UPDATE still affects 0 rows, the limit is reached → denied
 *
 * Returns { allowed, count, limit, remaining }.
 */
async function tryIncrement(
  scope: string,
  scopeId: string,
  limit: number,
  wKey: string,
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  // Step 1: Try conditional UPDATE (increment if below limit).
  const updateResult = await db.rateLimitCounter.updateMany({
    where: {
      scope,
      scopeId,
      windowKey: wKey,
      count: { lt: limit },
    },
    data: { count: { increment: 1 } },
  });

  if (updateResult.count > 0) {
    // Successfully incremented — the request is allowed.
    // Read the current count (for remaining calculation).
    const row = await db.rateLimitCounter.findUnique({
      where: {
        scope_scopeId_windowKey: { scope, scopeId, windowKey: wKey },
      },
      select: { count: true },
    });
    const count = row?.count ?? limit;
    return { allowed: true, count, remaining: Math.max(0, limit - count) };
  }

  // Step 2: Row might not exist yet. Try to INSERT.
  try {
    await db.rateLimitCounter.create({
      data: {
        scope,
        scopeId,
        windowKey: wKey,
        count: 1,
        expiresAt: new Date(Date.now() + RATE_LIMIT_CLEANUP_AGE_MS),
      },
    });
    // Successfully created with count=1 — the request is allowed.
    return { allowed: true, count: 1, remaining: Math.max(0, limit - 1) };
  } catch {
    // INSERT failed (unique constraint — row was created by another concurrent request).
    // Retry the conditional UPDATE.
    const retryResult = await db.rateLimitCounter.updateMany({
      where: {
        scope,
        scopeId,
        windowKey: wKey,
        count: { lt: limit },
      },
      data: { count: { increment: 1 } },
    });

    if (retryResult.count > 0) {
      const row = await db.rateLimitCounter.findUnique({
        where: {
          scope_scopeId_windowKey: { scope, scopeId, windowKey: wKey },
        },
        select: { count: true },
      });
      const count = row?.count ?? limit;
      return { allowed: true, count, remaining: Math.max(0, limit - count) };
    }
  }

  // Step 3: Limit reached — denied.
  const row = await db.rateLimitCounter.findUnique({
    where: {
      scope_scopeId_windowKey: { scope, scopeId, windowKey: wKey },
    },
    select: { count: true },
  });
  const count = row?.count ?? limit;
  return { allowed: false, count, remaining: 0 };
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Check the rate limit for a request.
 *
 * Checks ALL applicable scopes:
 *   1. key scope (if apiKeyId is present)
 *   2. tenant scope (ALWAYS — even for session-auth)
 *   3. sensitive scope (if path matches a sensitive pattern)
 *
 * A request is allowed ONLY if ALL applicable scopes pass.
 * If any scope fails, the request is denied (and the failing scope is returned).
 *
 * IMPORTANT: If a scope passes (counter incremented) but a later scope fails,
 * the earlier increments are NOT rolled back. See the module-level docstring
 * for rationale.
 *
 * Failure policy:
 *   - Non-sensitive endpoints: fail-open on DB error (allow request)
 *   - Sensitive endpoints: fail-closed on DB error (deny request)
 */
export async function checkRateLimit(
  identity: RateLimitIdentity,
): Promise<RateLimitResult> {
  const now = new Date();
  const wKey = windowKey(now);
  const resetAt = windowResetAt(now);

  // Build the list of scopes to check.
  const scopes: ScopeCheck[] = [];

  // 1. Key scope (if API key is present).
  if (identity.apiKeyId) {
    scopes.push({
      scope: "key",
      scopeId: identity.apiKeyId,
      limit: getKeyLimitPerMinute(),
    });
  }

  // 2. Tenant scope (ALWAYS — even for session-auth without API key).
  scopes.push({
    scope: "tenant",
    scopeId: identity.tenantId,
    limit: getTenantLimitPerMinute(),
  });

  // 3. Sensitive scope (if path matches).
  const isSensitive = SENSITIVE_ENDPOINT_PATTERNS.some((p) => p.test(identity.path));
  if (isSensitive) {
    scopes.push({
      scope: "sensitive",
      scopeId: `${identity.tenantId}:${identity.path}`,
      limit: getSensitiveLimitPerMinute(),
    });
  }

  // Check each scope. The first scope that fails denies the request.
  let strictestRemaining = Infinity;
  let strictestLimit = Infinity;
  let deniedScope: string | undefined;

  for (const s of scopes) {
    try {
      const result = await tryIncrement(s.scope, s.scopeId, s.limit, wKey);

      if (result.remaining < strictestRemaining) {
        strictestRemaining = result.remaining;
        strictestLimit = s.limit;
      }

      if (!result.allowed) {
        deniedScope = s.scope;
        logger.warn("rate_limit.exceeded", {
          tenantId: identity.tenantId,
          scope: s.scope,
          scopeId: s.scopeId,
          path: identity.path,
          count: result.count,
          limit: s.limit,
        });

        return {
          allowed: false,
          limit: s.limit,
          remaining: 0,
          resetAt,
          scope: s.scope,
          deniedScope: s.scope,
        };
      }
    } catch (err) {
      // DB failure — apply failure policy.
      if (isSensitive) {
        // Sensitive endpoint: fail-closed.
        logger.error("rate_limit.db_failure_fail_closed", {
          tenantId: identity.tenantId,
          scope: s.scope,
          scopeId: s.scopeId,
          path: identity.path,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          allowed: false,
          limit: s.limit,
          remaining: 0,
          resetAt,
          scope: s.scope,
          deniedScope: s.scope,
        };
      } else {
        // Non-sensitive endpoint: fail-open.
        logger.error("rate_limit.db_failure_fail_open", {
          tenantId: identity.tenantId,
          scope: s.scope,
          scopeId: s.scopeId,
          path: identity.path,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue checking other scopes (don't return yet — other scopes might still pass).
        // This scope is treated as "passed" (no increment, but no denial either).
      }
    }
  }

  // All scopes passed (or failed-open).
  return {
    allowed: true,
    limit: strictestLimit,
    remaining: strictestRemaining,
    resetAt,
    scope: scopes[scopes.length - 1].scope, // the last scope checked
  };
}

/**
 * Prune old rate limit counters. Called by the connectivity-reconcile cron
 * to prevent unbounded growth.
 */
export async function pruneRateLimitEvents(): Promise<{ pruned: number }> {
  const cutoff = new Date(Date.now() - RATE_LIMIT_CLEANUP_AGE_MS);

  // Delete old RateLimitCounter rows (expired windows).
  const result = await db.rateLimitCounter.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });

  // Also clean up old RateLimitEvent rows (legacy, if any exist).
  try {
    await db.rateLimitEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  } catch {
    // RateLimitEvent table might not exist in some deployments.
  }

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
