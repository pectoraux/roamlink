/**
 * Phase 12.3.6 — Unified API principal resolver.
 *
 * The external /api/v1/* surface accepts EITHER:
 *   - a browser session (cookie-based, via getCurrentUser + requireTenantContext)
 *   - an API key (Authorization: Bearer rlk_... or x-api-key)
 *
 * This module resolves either auth method into a unified ApiPrincipal that
 * carries the authoritative tenantId — the caller CANNOT override it.
 *
 *   request
 *     ↓
 *   extractApiKeyStatus(req)
 *     ├─ present  → verifyApiKey → ApiKeyPrincipal  (tenantId from key)
 *     ├─ malformed → 401 auth_malformed
 *     └─ absent   → getCurrentUser + requireTenantContext  (tenantId from session)
 *
 * The resolved principal's tenantId is authoritative for all downstream
 * tenant-scoped DB queries. This is the Phase 12.2 tenant boundary applied
 * to the external API surface.
 *
 * ERROR SEMANTICS (canonical envelope):
 *   - no auth at all (no key, no session) → 401 auth_required
 *   - malformed API-key header → 401 auth_malformed
 *   - invalid/revoked/expired key → 401 auth_invalid / auth_revoked / auth_expired
 *   - valid key but insufficient scope → 403 scope_insufficient
 *   - valid session but no active tenant → 403 forbidden ("No active tenant")
 */

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import {
  extractApiKeyStatus,
  verifyApiKey,
  type ApiKeyPrincipal,
  type ApiKeyScope,
} from "@/lib/auth/api-key";
import { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Unified principal
// ---------------------------------------------------------------------------

export type ApiPrincipal =
  | { type: "session"; userId: string; tenantId: string; role: string }
  | { type: "api_key" } & ApiKeyPrincipal;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the API principal from either an API key or a browser session.
 *
 * @param req The incoming request.
 * @param requiredScope The scope required IF auth is via API key. Session auth
 *   bypasses scope checks (the user's tenant role is the authority instead).
 *   Defaults to "read".
 *
 * @throws AppError with canonical error semantics (see module docstring).
 */
export async function resolveApiPrincipal(
  req: NextRequest,
  requiredScope: ApiKeyScope = "read",
): Promise<ApiPrincipal> {
  const extraction = extractApiKeyStatus(req);

  if (extraction.status === "malformed") {
    throw new AppError("auth", extraction.reason, 401, "The provided API key has an invalid format.");
  }

  if (extraction.status === "present") {
    // API-key auth path.
    const principal = await verifyApiKey(extraction.rawKey);
    if (!principal) {
      throw new AppError("auth", "Invalid, revoked, or expired API key", 401, "The provided API key is invalid, revoked, or expired.");
    }
    // Scope check (admin implies all).
    if (requiredScope !== "read" && !principal.scopes.includes("admin" as ApiKeyScope)) {
      if (!principal.scopes.includes(requiredScope)) {
        throw new AppError(
          "authorization",
          `API key lacks required scope: ${requiredScope}`,
          403,
          `Your API key does not have the "${requiredScope}" scope required for this operation.`,
        );
      }
    }
    return { type: "api_key", ...principal };
  }

  // absent → fall through to session auth.
  const user = await getCurrentUser();
  if (!user) {
    throw new AppError("auth", "No API key or session provided", 401, "Provide an API key via Authorization: Bearer, or sign in via the web app.");
  }
  const ctx = await requireTenantContext(user);
  return {
    type: "session",
    userId: user.id,
    tenantId: ctx.tenantId,
    role: ctx.role,
  };
}

/**
 * Get the authoritative tenantId from a resolved principal.
 * This is the value all downstream tenant-scoped DB queries MUST use.
 */
export function principalTenantId(principal: ApiPrincipal): string {
  return principal.tenantId;
}

/**
 * Get the principal's identity for audit logging.
 */
export function principalAuditId(principal: ApiPrincipal): { principalId: string; principalType: "session" | "api_key" } {
  if (principal.type === "session") {
    return { principalId: principal.userId, principalType: "session" };
  }
  return { principalId: principal.id, principalType: "api_key" };
}
