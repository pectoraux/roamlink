/**
 * Phase 10 — Observation Trust & Provenance Protocol
 *
 * Device telemetry is evidence, not authority.
 *
 *   Persisted observation ≠ Eligible measurement ≠ Authoritative health ≠ Decision authority
 *
 * The server alone derives trust. The mobile client never submits trust.
 *
 * ---------------------------------------------------------------------------
 * Two distinct time windows (Phase 10.1.1 — intentionally documented):
 *
 *   1. INGESTION ACCEPTANCE WINDOW  (OBSERVATION_VALIDATION.maxAgeMs)
 *      Whether to ACCEPT an incoming observation at all. An observation older
 *      than this is classified STALE + UNTRUSTED at ingestion and stored for
 *      audit, but the trust firewall excludes it from health derivation.
 *
 *   2. HEALTH CONTRIBUTION WINDOW  (health-derivation.DEFAULT_WINDOW_MS)
 *      Whether an ACCEPTED measurement contributes to the CURRENT health
 *      snapshot. The freshness classification (FRESH/STALE/EXPIRED) is a
 *      SEPARATE, finer-grained signal derived from capturedAt at read time.
 *
 * These are different policies and MUST NOT be collapsed into one. The
 * ingestion window is an acceptance gate (audit boundary). The health window
 * is a contribution gate (control-plane authority boundary). Future agents:
 * do not “simplify” one into the other.
 * ---------------------------------------------------------------------------
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
 * STALE — capturedAt is too old (beyond the ingestion acceptance window)
 * FUTURE_TIMESTAMP — capturedAt is in the future (clock skew or fabrication)
 * INVALID_METRIC — metric values are physically impossible
 * RESOURCE_MISMATCH — device claims a resource it doesn't own (hint doesn't
 *   match the session's active resource, or session ownership violation)
 * RATE_LIMITED — device is submitting too fast (burst/flood)
 *
 * Phase 10.1.1: DUPLICATE is NOT a member of this type. Duplicate observations
 * are deduped at the ingestion boundary (by observationId / deviceId+sequence)
 * BEFORE validateObservation() is called, so they never receive an integrity
 * classification on a persisted measurement. DUPLICATE is an INGESTION OUTCOME
 * surfaced in the EdgeObservationAck (duplicate=true / rejected[]), not a
 * measurement-integrity state. Mixing the two would suggest a measurement could
 * be persisted with integrity=DUPLICATE, which the pipeline never produces.
 */
export type ObservationIntegrity =
  | "VALID"
  | "STALE"
  | "FUTURE_TIMESTAMP"
  | "INVALID_METRIC"
  | "RESOURCE_MISMATCH"
  | "RATE_LIMITED";

/**
 * Phase 10.1.1: Ingestion outcomes (distinct from measurement integrity).
 *
 * These are the outcomes of the ingestion pipeline, returned in the
 * EdgeObservationAck. They are NOT persisted on ConnectivityMeasurement.integrity
 * (which uses ObservationIntegrity). The separation makes explicit that
 * DUPLICATE is an ingestion-time decision, not a measurement state.
 */
export type IngestionOutcome = "ACCEPTED" | "DUPLICATE" | "REJECTED";

// ---------------------------------------------------------------------------
// Validation parameters
// ---------------------------------------------------------------------------

export const OBSERVATION_VALIDATION = {
  // ---------------------------------------------------------------------------
  // INGESTION ACCEPTANCE WINDOW (Phase 10.1.1)
  // An observation older than this is classified STALE + UNTRUSTED at
  // ingestion. It is persisted for audit but excluded from health derivation.
  // This is conceptually distinct from the HEALTH CONTRIBUTION WINDOW
  // (health-derivation.DEFAULT_WINDOW_MS) — see the file header.
  // ---------------------------------------------------------------------------
  maxAgeMs: 5 * 60 * 1000,       // 5 minutes — older = STALE
  maxFutureMs: 30 * 1000,         // 30 seconds — future beyond this = FUTURE_TIMESTAMP

  // Metric plausibility bounds
  maxThroughputMbps: 10_000,     // 10 Gbps — anything higher is impossible
  maxLatencyMs: 60_000,           // 60 seconds — anything higher is impossible
  maxPacketLossPct: 100,          // 100% — anything higher is impossible
  minThroughputMbps: 0,           // can't be negative
  minLatencyMs: 0,                // can't be negative

  // ---------------------------------------------------------------------------
  // PER-DEVICE RATE LIMITING (Phase 10.1.1)
  // The window over which observations from a single device are counted.
  // Counting is done on EdgeObservationRecord (deviceId, observedAt) — NOT on
  // ConnectivityMeasurement by resource. This makes the limit genuinely
  // per-device: two devices reporting on the same resource get separate
  // buckets, and a device cannot evade the limit by switching resource context.
  //
  // Off-by-one note: the count is performed AFTER the record is persisted (the
  // pipeline creates the record, then calls validateObservation which counts).
  // So the count INCLUDES the current observation. The condition in
  // validateObservation is strictly-greater-than (>): the Nth observation has
  // count=N, so count>60 fires at N=61 (the 61st), not at N=60 (the 60th,
  // which is within the limit). This means observations 1..60 are VALID and
  // the 61st is the first to be RATE_LIMITED.
  // ---------------------------------------------------------------------------
  rateLimitWindowMs: 60_000,      // 1 minute rolling window
  maxObservationsPerMinute: 60,   // 1 per second max per device; 61st is rate-limited
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
