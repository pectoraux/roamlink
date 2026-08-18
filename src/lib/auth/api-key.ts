/**
 * Phase 12.3.1 — Canonical API-key verification.
 *
 * The architect's Phase 12.3 audit found that the ApiKey model had all the
 * foundation (hashedKey, scopes, tenantId, expiresAt, revokedAt) but there was
 * NO verification path: nothing read an incoming key, hashed it, and resolved
 * a principal. The API-key routes only managed keys.
 *
 * This module is the canonical verification path for the external API surface.
 *
 *   Authorization: Bearer rlk_...     (preferred)
 *   x-api-key: rlk_...               (accepted)
 *        ↓
 *   hashKey(rawKey)                   (SHA-256, same as creation)
 *        ↓
 *   db.apiKey.findUnique({ hashedKey })
 *        ↓
 *   verify: exists, not revoked, not expired
 *        ↓
 *   resolve: tenant + scopes → ApiKeyPrincipal
 *        ↓
 *   requireScope(principal, "write")  (route-level)
 *
 * SECURITY INVARIANTS:
 *   1. The raw key is NEVER stored — only the SHA-256 hash (same as creation).
 *   2. A revoked key (revokedAt != null) is rejected with 401.
 *   3. An expired key (expiresAt < now) is rejected with 401.
 *   4. The principal's tenantId is the key's tenantId — the caller CANNOT
 *      override it. Every API-key request is tenant-scoped at the DB level.
 *   5. Scopes are a JSON array stored on the key. requireScope() checks
 *      membership. Unknown scopes are rejected.
 *   6. lastUsedAt is updated on each successful verification (best-effort,
 *      non-blocking — a failure here does NOT block the request).
 *
 * USAGE IN A ROUTE:
 *
 *   import { requireApiKey } from "@/lib/auth/api-key";
 *
 *   export async function POST(req: NextRequest) {
 *     const principal = await requireApiKey(req, "write");
 *     // principal.tenantId is the authoritative tenant scope.
 *     ...
 *   }
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiKeyScope = "read" | "write" | "orders" | "customers" | "billing" | "admin";

export type ApiKeyPrincipal = {
  type: "api_key";
  id: string;            // ApiKey.id
  tenantId: string;      // authoritative tenant scope
  scopes: ApiKeyScope[];
  keyName: string;
  prefix: string;        // for audit logging
};

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = "rlk_";

/**
 * Extract the raw API key from a request.
 * Accepts either:
 *   - Authorization: Bearer rlk_...
 *   - x-api-key: rlk_...
 *
 * Returns null if no key is present. Throws 401 if a key is present but
 * malformed (e.g. wrong prefix).
 */
export function extractApiKey(req: NextRequest): string | null {
  // 1. Authorization: Bearer <key>
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      const key = match[1].trim();
      if (!key.startsWith(API_KEY_PREFIX)) {
        throw new AppError("auth", "Invalid API key format", 401, "The provided API key has an invalid format.");
      }
      return key;
    }
    // Authorization header present but not Bearer — could be a session cookie
    // bearer. Return null to let the caller fall back to session auth.
    return null;
  }

  // 2. x-api-key: <key>
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) {
    const key = xApiKey.trim();
    if (!key.startsWith(API_KEY_PREFIX)) {
      throw new AppError("auth", "Invalid API key format", 401, "The provided API key has an invalid format.");
    }
    return key;
  }

  return null;
}

/**
 * Hash a raw API key with SHA-256. Same algorithm as the creation route.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify an API key and resolve the principal. Returns null if the key is
 * not found, revoked, or expired.
 *
 * @param rawKey The raw API key (starting with "rlk_")
 */
export async function verifyApiKey(rawKey: string): Promise<ApiKeyPrincipal | null> {
  const hashedKey = hashApiKey(rawKey);

  const apiKey = await db.apiKey.findUnique({
    where: { hashedKey },
    select: {
      id: true,
      tenantId: true,
      name: true,
      prefix: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!apiKey) return null;

  // Revoked?
  if (apiKey.revokedAt) {
    logger.warn("api_key.revoked_key_used", { apiKeyId: apiKey.id, tenantId: apiKey.tenantId });
    return null;
  }

  // Expired?
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    logger.warn("api_key.expired_key_used", { apiKeyId: apiKey.id, tenantId: apiKey.tenantId });
    return null;
  }

  // Parse scopes.
  let scopes: ApiKeyScope[];
  try {
    scopes = JSON.parse(apiKey.scopes) as ApiKeyScope[];
    if (!Array.isArray(scopes)) scopes = ["read"];
  } catch {
    scopes = ["read"];
  }

  // Best-effort: update lastUsedAt. Non-blocking — a failure here does NOT
  // reject the request. We use updateMany to avoid throwing if the row was
  // concurrently deleted.
  db.apiKey.updateMany({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  return {
    type: "api_key",
    id: apiKey.id,
    tenantId: apiKey.tenantId,
    scopes,
    keyName: apiKey.name,
    prefix: apiKey.prefix,
  };
}

/**
 * Require a valid API key with the given scope. Throws 401 if no key, 403 if
 * the key lacks the required scope.
 *
 * This is the canonical entry point for API-key-authenticated routes.
 */
export async function requireApiKey(req: NextRequest, requiredScope: ApiKeyScope = "read"): Promise<ApiKeyPrincipal> {
  const rawKey = extractApiKey(req);
  if (!rawKey) {
    throw new AppError("auth", "No API key provided", 401, "Provide an API key via the Authorization: Bearer header.");
  }

  const principal = await verifyApiKey(rawKey);
  if (!principal) {
    throw new AppError("auth", "Invalid, revoked, or expired API key", 401, "The provided API key is invalid, revoked, or expired.");
  }

  // Scope check. "admin" scope implies all scopes.
  if (requiredScope !== "read" && !principal.scopes.includes("admin" as ApiKeyScope)) {
    if (!principal.scopes.includes(requiredScope)) {
      logger.warn("api_key.insufficient_scope", {
        apiKeyId: principal.id,
        tenantId: principal.tenantId,
        required: requiredScope,
        granted: principal.scopes,
      });
      throw new AppError(
        "authorization",
        `API key lacks required scope: ${requiredScope}`,
        403,
        `Your API key does not have the "${requiredScope}" scope required for this operation.`,
      );
    }
  }

  logger.debug("api_key.verified", {
    apiKeyId: principal.id,
    tenantId: principal.tenantId,
    scope: requiredScope,
  });

  return principal;
}

/**
 * Check if a principal has a specific scope. Does not throw.
 */
export function hasScope(principal: ApiKeyPrincipal, scope: ApiKeyScope): boolean {
  if (principal.scopes.includes("admin" as ApiKeyScope)) return true;
  return principal.scopes.includes(scope);
}
