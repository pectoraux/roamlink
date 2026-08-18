/**
 * Phase 12.3.5 — API Version / Compatibility Contract.
 *
 * This module establishes the EXTERNAL API protocol contract for /api/v1/*.
 *
 * CONTRACT
 * ========
 *
 *   /api/v1/* is a STABLE external contract.
 *
 *   - Non-breaking additions are allowed at any time (new fields, new endpoints,
 *     new optional parameters).
 *   - Breaking changes require a new major version (v2, v3, ...).
 *   - A "breaking change" is ANY change that could cause a correctly-written
 *     v1 client to break. This includes:
 *       - Removing a field from a response.
 *       - Changing a field's type or semantics.
 *       - Changing the error code taxonomy (stable codes are part of the contract).
 *       - Changing the authentication model.
 *       - Changing the idempotency semantics.
 *       - Making an optional parameter required.
 *       - Changing the HTTP status code for a given condition.
 *   - A "non-breaking addition" is:
 *       - Adding a NEW field to a response (clients ignore unknown fields).
 *       - Adding a NEW endpoint.
 *       - Adding a NEW optional request parameter.
 *       - Adding a NEW error code (clients should treat unknown codes as
 *         "internal_error" — see the compatibility rule below).
 *
 * DEPRECATION
 * ===========
 *
 *   - A deprecated endpoint/field returns a `Deprecation` HTTP header:
 *       Deprecation: true
 *       Sunset: <RFC 7231 date>  (optional — when the endpoint will be removed)
 *       Link: <v2-replacement-url>; rel="successor-version"
 *   - Deprecated endpoints remain functional for at least 6 months after the
 *     deprecation header is added.
 *   - Removal requires a new major version.
 *
 * COMPATIBILITY RULES FOR CLIENTS
 * ===============================
 *
 *   1. Clients MUST branch on `error.code` (stable taxonomy), never on
 *      `error.message` (human-readable, may change wording).
 *   2. Clients MUST treat unknown error codes as `internal_error` (forward compat).
 *   3. Clients MUST ignore unknown response fields (forward compat).
 *   4. Clients MUST send `x-request-id` for correlation (server returns it in
 *      the response header and in `error.requestId`).
 *   5. Clients MUST NOT retry a RECONCILIATION_REQUIRED outcome with a new key.
 *   6. Clients MUST NOT assume a field is present in the response (optional
 *      fields may be absent).
 *
 * VERSION NEGOTIATION
 * ===================
 *
 *   - The version is in the URL path: /api/v1/*
 *   - There is no Accept-header negotiation — the URL path is the version.
 *   - A request to /api/v2/* (when it exists) gets the v2 contract.
 *   - A request to /api/ (no version) gets 404 — the version is required.
 *   - A request to /api/v0/* or /api/v99/* gets 404 — unknown version.
 *
 * ENFORCEMENT
 * ===========
 *
 *   - The version contract is enforced at the route boundary by the
 *     `requireApiVersion` helper, which validates the version and attaches
 *     the contract metadata to the response headers.
 *   - The `CURRENT_API_VERSION` constant is the current stable major version.
 *   - The `SUPPORTED_API_VERSIONS` array lists all supported versions.
 */

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

/**
 * The current stable major version of the external API.
 * Breaking changes require incrementing this and creating /api/v2/*.
 */
export const CURRENT_API_VERSION = 1 as const;

/**
 * All supported major versions. Currently only v1.
 * When v2 is introduced, this will be [1, 2] until v1 is sunset.
 */
export const SUPPORTED_API_VERSIONS: readonly number[] = [CURRENT_API_VERSION] as const;

/**
 * The minimum supported version. Requests to older versions get 410 Gone.
 * Currently this is 1 (no older versions exist).
 */
export const MIN_API_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Version validation
// ---------------------------------------------------------------------------

/**
 * Validate that a version number is supported.
 * Returns the version if supported, or null if not.
 */
export function isSupportedVersion(version: number): boolean {
  return SUPPORTED_API_VERSIONS.includes(version);
}

/**
 * Parse the version from an API path like "/api/v1/connectivity/sessions".
 * Returns the version number, or null if the path doesn't match the pattern.
 */
export function parseApiVersion(pathname: string): number | null {
  const match = pathname.match(/^\/api\/v(\d+)\//);
  if (!match) return null;
  const version = parseInt(match[1], 10);
  if (isNaN(version)) return null;
  return version;
}

// ---------------------------------------------------------------------------
// Deprecation headers
// ---------------------------------------------------------------------------

export type DeprecationInfo = {
  /** True if the endpoint or field is deprecated. */
  deprecated: boolean;
  /** RFC 7231 date when the endpoint will be removed (optional). */
  sunset?: string;
  /** URL of the successor-version endpoint (optional). */
  successorVersion?: string;
};

/**
 * Build the deprecation HTTP headers for a response.
 *
 *   Deprecation: true
 *   Sunset: <date>
 *   Link: <url>; rel="successor-version"
 */
export function deprecationHeaders(info: DeprecationInfo): Record<string, string> {
  const headers: Record<string, string> = {};
  if (info.deprecated) {
    headers["Deprecation"] = "true";
    if (info.sunset) {
      headers["Sunset"] = info.sunset;
    }
    if (info.successorVersion) {
      headers["Link"] = `<${info.successorVersion}>; rel="successor-version"`;
    }
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Version contract metadata (attached to responses)
// ---------------------------------------------------------------------------

/**
 * The API version contract metadata, attached to every /api/v1/* response
 * via the `X-API-Version` and `X-API-Stable` headers.
 */
export function versionHeaders(version: number): Record<string, string> {
  return {
    "X-API-Version": String(version),
    "X-API-Stable": "true", // v1 is a stable contract
  };
}

// ---------------------------------------------------------------------------
// Breaking-change policy (documentation + assertion helper)
// ---------------------------------------------------------------------------

/**
 * The breaking-change policy. This is documented here so it can be referenced
 * in code review and architectural audits.
 *
 * POLICY:
 *   1. v1 is a stable contract. Breaking changes are NOT allowed in v1.
 *   2. Breaking changes require a new major version (v2).
 *   3. A new major version is created by:
 *      a. Creating /api/v2/* routes (copy of v1 + breaking changes).
 *      b. Adding v2 to SUPPORTED_API_VERSIONS.
 *      c. Adding Deprecation headers to the v1 routes that v2 supersedes.
 *      d. Keeping v1 functional for at least 6 months after deprecation.
 *   4. Removal of v1 requires:
 *      a. v2 has been stable for at least 6 months.
 *      b. All monitored v1 traffic has migrated to v2.
 *      c. v1 routes return 410 Gone.
 *
 * This policy is enforced by code review, not by runtime logic. The runtime
 * enforcement is the version number in the URL path + the SUPPORTED_API_VERSIONS
 * check.
 */
export const BREAKING_CHANGE_POLICY = `
v1 is a STABLE external contract.

Breaking changes are NOT allowed in v1. They require a new major version (v2).

Breaking changes include:
  - Removing a field from a response
  - Changing a field's type or semantics
  - Changing the error code taxonomy (stable codes are part of the contract)
  - Changing the authentication model
  - Changing the idempotency semantics
  - Making an optional parameter required
  - Changing the HTTP status code for a given condition

Non-breaking additions are allowed:
  - Adding a NEW field to a response (clients ignore unknown fields)
  - Adding a NEW endpoint
  - Adding a NEW optional request parameter
  - Adding a NEW error code (clients treat unknown codes as internal_error)

Deprecation:
  - Deprecated endpoints return Deprecation: true header
  - Deprecated endpoints remain functional for at least 6 months
  - Removal requires a new major version
` as const;

// ---------------------------------------------------------------------------
// Unknown error code compatibility rule
// ---------------------------------------------------------------------------

/**
 * The compatibility rule for unknown error codes. Clients MUST treat unknown
 * codes as "internal_error". This allows the server to add new error codes
 * without breaking existing clients.
 *
 * This is enforced by the apiErrorResponse() helper in lib/api/protocol.ts,
 * which always includes a stable code from the taxonomy. If a new code is
 * added that a client doesn't recognize, the client falls back to
 * "internal_error" behavior.
 */
export const UNKNOWN_CODE_COMPATIBILITY_RULE =
  "Clients MUST treat unknown error codes as 'internal_error'. " +
  "This allows the server to add new error codes without breaking existing clients." as const;
