/**
 * Phase 12.4.4e — Incident Lookup API.
 *
 * GET /api/v1/connectivity/incidents — look up an operational incident by
 * one of the supported correlation keys. Returns the complete causal chain
 * (request → intent version → decision → action → session → binding →
 * provider operations) as a read-only view.
 *
 * AUTHENTICATION: requires an authenticated API principal (resolveApiPrincipal).
 *   - API key with "read" scope, OR
 *   - Browser session with an active tenant context.
 *
 * TENANT SCOPE: every lookup is tenant-scoped. The principal's tenantId is
 * authoritative — the caller CANNOT override it. Cross-tenant lookups return
 * a safe 404 not-found WITHOUT disclosing whether the object exists under
 * another tenant.
 *
 * VERSION SAFETY: when reconstructing a decision's causality, the service uses
 * (intentId, intentVersion) from the decision record — NOT "latest active
 * version." Stale decisions retain their original request's causality
 * (Phase 12.4.4c.3 invariant).
 *
 * READ-ONLY: this endpoint never executes actions, retries provider
 * operations, or modifies any state. It is purely a query surface.
 *
 * QUERY PARAMETERS (exactly one required):
 *   ?requestId=<value>
 *   ?intentId=<value>[&version=<n>]
 *   ?decisionId=<value>
 *   ?actionId=<value>
 *   ?providerResourceId=<value>
 *   ?bindingId=<value>
 *   ?providerKey=<value>
 *
 * RESPONSE: 200 with IncidentResult JSON, or 404 not_found, or 400
 * validation_failed if no key / too many keys supplied.
 *
 * Example:
 *   GET /api/v1/connectivity/incidents?requestId=req_abc123
 *   → 200 { incident: {...}, intent: {...}, decision: {...}, action: {...}, ... }
 */

import { NextRequest } from "next/server";
import { resolveApiPrincipal, principalTenantId } from "@/lib/api/principal";
import { getRequestId, apiV1ErrorResponse, apiV1SuccessResponse } from "@/lib/api/protocol";
import { enforceRateLimit } from "@/lib/api/rate-limit-helper";
import { lookupIncident, type IncidentLookupKey } from "@/lib/observability/incident-lookup";
import { AppError } from "@/lib/errors";

const ALLOWED_KEYS = [
  "requestId",
  "intentId",
  "decisionId",
  "actionId",
  "providerResourceId",
  "bindingId",
  "providerKey",
] as const;

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    // Step 1: Authenticate (API key OR session — both work).
    const principal = await resolveApiPrincipal(req, "read");
    const callerTenantId = principalTenantId(principal);

    // Phase 12.4.6.2: Rate limit check (after auth, before handler logic).
    const rateLimitResult = await enforceRateLimit({
      tenantId: callerTenantId,
      apiKeyId: principal.type === "api_key" ? principal.id : undefined,
      path: new URL(req.url).pathname,
    }, requestId);
    if (!rateLimitResult.allowed) return rateLimitResult.response!;

    // Step 2: Parse the lookup key from query parameters.
    const url = new URL(req.url);
    const present = ALLOWED_KEYS.filter((k) => url.searchParams.get(k));
    if (present.length === 0) {
      throw new AppError(
        "validation",
        `No lookup key supplied. Provide exactly one of: ${ALLOWED_KEYS.join(", ")}`,
        400,
        `Provide exactly one lookup key: ${ALLOWED_KEYS.join(", ")}.`,
      );
    }
    if (present.length > 1) {
      throw new AppError(
        "validation",
        `Multiple lookup keys supplied (${present.join(", ")}). Provide exactly one.`,
        400,
        `Provide exactly one lookup key, not multiple.`,
      );
    }
    const kind = present[0];
    const rawValue = url.searchParams.get(kind);
    if (!rawValue || rawValue.length === 0 || rawValue.length > 256) {
      throw new AppError(
        "validation",
        `Lookup key ${kind} has invalid value (empty or too long).`,
        400,
        `Lookup key ${kind} is invalid.`,
      );
    }
    // Sanitize: allow only alphanumeric + underscore + hyphen (same charset as requestId).
    if (!/^[a-zA-Z0-9_-]+$/.test(rawValue)) {
      throw new AppError(
        "validation",
        `Lookup key ${kind} contains invalid characters.`,
        400,
        `Lookup key ${kind} contains invalid characters.`,
      );
    }

    // Step 3: Build the typed lookup key.
    let key: IncidentLookupKey;
    if (kind === "intentId") {
      const versionStr = url.searchParams.get("version");
      const version = versionStr !== null ? parseInt(versionStr, 10) : undefined;
      if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 1_000_000)) {
        throw new AppError(
          "validation",
          "version must be a positive integer",
          400,
          "version must be a positive integer.",
        );
      }
      key = { kind: "intentId", value: rawValue, version };
    } else {
      key = { kind, value: rawValue } as IncidentLookupKey;
    }

    // Step 4: Look up the incident (tenant-scoped, version-safe, read-only).
    const result = await lookupIncident(key, callerTenantId);

    return apiV1SuccessResponse(result, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
