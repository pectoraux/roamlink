/**
 * Phase 10 — Observation Trust & Provenance Protocol
 *
 * Device telemetry is evidence, not authority.
 *
 *   Persisted observation ≠ Eligible measurement ≠ Authoritative health ≠ Decision authority
 *
 * The server alone derives trust. The mobile client never submits trust.
 */

// ---------------------------------------------------------------------------
// Observation Source (who produced the observation)
// ---------------------------------------------------------------------------

export type ObservationSource = "DEVICE" | "PROVIDER" | "SERVER_SYNTHETIC" | "OTHER";

// ---------------------------------------------------------------------------
// Observation Trust (server-derived authority level)
// ---------------------------------------------------------------------------

/**
 * UNTRUSTED — observation failed validation or is suspicious.
 *   May be stored + audited. Must NOT influence health or decisions.
 *
 * LIMITED — valid observation from a lower-authority source (device).
 *   May contribute to health derivation alongside trusted evidence.
 *
 * TRUSTED — observation from a high-authority source (provider adapter,
 *   server synthetic). Authoritative for health derivation.
 *
 * The server alone derives trust. The mobile client never submits trust.
 */
export type ObservationTrust = "UNTRUSTED" | "LIMITED" | "TRUSTED";

// ---------------------------------------------------------------------------
// Observation Integrity (validation result at ingestion)
// ---------------------------------------------------------------------------

/**
 * The result of validating an incoming edge observation.
 * These are observation-integrity states, NOT decision reason codes.
 *
 * VALID — observation passed all validation checks
 * STALE — capturedAt is too old (beyond the acceptance window)
 * FUTURE_TIMESTAMP — capturedAt is in the future (clock skew or fabrication)
 * INVALID_METRIC — metric values are physically impossible
 * RESOURCE_MISMATCH — device claims resource it doesn't own
 * RATE_LIMITED — device is submitting too fast (burst/flood)
 * DUPLICATE — already processed (deduplicated)
 */
export type ObservationIntegrity =
  | "VALID"
  | "STALE"
  | "FUTURE_TIMESTAMP"
  | "INVALID_METRIC"
  | "RESOURCE_MISMATCH"
  | "RATE_LIMITED"
  | "DUPLICATE";

// ---------------------------------------------------------------------------
// Validation parameters
// ---------------------------------------------------------------------------

export const OBSERVATION_VALIDATION = {
  // capturedAt must be within this window of "now" to be considered VALID
  maxAgeMs: 5 * 60 * 1000,       // 5 minutes — older = STALE
  maxFutureMs: 30 * 1000,         // 30 seconds — future beyond this = FUTURE_TIMESTAMP

  // Metric plausibility bounds
  maxThroughputMbps: 10_000,     // 10 Gbps — anything higher is impossible
  maxLatencyMs: 60_000,           // 60 seconds — anything higher is impossible
  maxPacketLossPct: 100,          // 100% — anything higher is impossible
  minThroughputMbps: 0,           // can't be negative
  minLatencyMs: 0,                // can't be negative

  // Rate limiting: max observations per device per minute
  maxObservationsPerMinute: 60,   // 1 per second max
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a measurement with this trust level is eligible
 * to influence resource health derivation.
 *
 * TRUSTED → yes (provider/server evidence)
 * LIMITED → yes (valid device evidence — contributes but doesn't override)
 * UNTRUSTED → no (failed validation — stored but excluded from health)
 */
export function isEligibleForHealth(trust: ObservationTrust): boolean {
  return trust === "TRUSTED" || trust === "LIMITED";
}

/**
 * Map an observation source to a default trust level.
 * The server may upgrade or downgrade trust based on validation results.
 */
export function defaultTrustForSource(source: ObservationSource): ObservationTrust {
  switch (source) {
    case "PROVIDER":
    case "SERVER_SYNTHETIC":
      return "TRUSTED";
    case "DEVICE":
      return "LIMITED"; // valid device evidence is limited-trust
    case "OTHER":
    default:
      return "UNTRUSTED";
  }
}
