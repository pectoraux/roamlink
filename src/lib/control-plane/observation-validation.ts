/**
 * Phase 10 — Observation Validation & Trust Derivation
 *
 * Validates incoming edge observations and derives server-side trust/integrity
 * classification. The server alone derives trust — the mobile client never
 * submits trust.
 *
 *   Device telemetry is evidence, not authority.
 *
 * Validation checks (in evaluation order):
 *   A. capturedAt sanity window (STALE / FUTURE_TIMESTAMP)
 *   B. Impossible metric values (INVALID_METRIC)
 *   C. Resource/session consistency (RESOURCE_MISMATCH)
 *      — Phase 10.1.1: the caller passes the device-supplied hint + a
 *        mismatch flag resolved by validateResourceHint(). The mismatch is
 *        classified here so the persisted measurement carries the
 *        RESOURCE_MISMATCH + UNTRUSTED classification (auditable), instead
 *        of being silently cleared at the ingestion boundary.
 *   D. Per-device rate limiting (RATE_LIMITED)
 *      — Phase 10.1.1: keyed by (deviceId, observedAt) on EdgeObservationRecord,
 *        NOT by (resourceId, source) on ConnectivityMeasurement. Two devices
 *        reporting on the same resource get separate buckets; a device cannot
 *        evade the limit by switching resource context. Counting observation
 *        records (not measurements) is correct because suspicious observations
 *        that never project to a measurement still count toward the limit.
 *
 * Suspicious observations are NOT deleted — they are persisted with their
 * integrity classification so they remain auditable.
 *
 * NOTE on duplicate semantics (Phase 10.1.1):
 *   DUPLICATE is an INGESTION OUTCOME returned in the EdgeObservationAck
 *   (duplicate=true / rejected[]), NOT a measurement-integrity state. Duplicate
 *   observations are deduped before validateObservation() is called, so they
 *   never receive an integrity classification on a persisted measurement.
 *   The DUPLICATE value was removed from ObservationIntegrity to make this
 *   explicit in the type system.
 */

import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import {
  OBSERVATION_VALIDATION,
  type ObservationIntegrity,
  type ObservationTrust,
  type ObservationSource,
  defaultTrustForSource,
} from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationResult = {
  integrity: ObservationIntegrity;
  trust: ObservationTrust;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Validate an observation
// ---------------------------------------------------------------------------

export async function validateObservation(input: {
  deviceId: string;
  resourceId?: string | null;
  sessionId?: string | null;
  /**
   * Phase 10.1.1: The device-supplied resourceId hint. Used to detect
   * RESOURCE_MISMATCH when it differs from the session's active resource.
   * The caller (validateResourceHint) resolves this signal; we classify it
   * here so the persisted measurement carries the integrity state.
   */
  hintResourceId?: string | null;
  /**
   * Phase 10.1.1: Pre-resolved mismatch flag from validateResourceHint.
   * When true, the observation is classified RESOURCE_MISMATCH + UNTRUSTED
   * regardless of other checks (the device claimed a resource it doesn't own).
   */
  resourceMismatch?: boolean;
  userId: string;
  observedAt: Date;
  source: ObservationSource;
  metrics: Record<string, unknown>;
}): Promise<ValidationResult> {
  const now = Date.now();
  const capturedMs = input.observedAt.getTime();
  const ageMs = now - capturedMs;

  // A. capturedAt sanity window
  if (capturedMs > now + OBSERVATION_VALIDATION.maxFutureMs) {
    return {
      integrity: "FUTURE_TIMESTAMP",
      trust: "UNTRUSTED",
      reason: `capturedAt is ${Math.round((capturedMs - now) / 1000)}s in the future`,
    };
  }

  if (ageMs > OBSERVATION_VALIDATION.maxAgeMs) {
    return {
      integrity: "STALE",
      trust: "UNTRUSTED",
      reason: `capturedAt is ${Math.round(ageMs / 1000)}s old (max ${OBSERVATION_VALIDATION.maxAgeMs / 1000}s)`,
    };
  }

  // B. Impossible metric values
  const metricError = validateMetrics(input.metrics);
  if (metricError) {
    return {
      integrity: "INVALID_METRIC",
      trust: "UNTRUSTED",
      reason: metricError,
    };
  }

  // C. Resource/session consistency.
  // Phase 10.1.1: The caller resolves the mismatch signal in validateResourceHint()
  // and passes it here. This is the authoritative classification point — the
  // measurement is persisted with RESOURCE_MISMATCH + UNTRUSTED so it remains
  // auditable (the health firewall excludes UNTRUSTED from derivation).
  if (input.resourceMismatch) {
    return {
      integrity: "RESOURCE_MISMATCH",
      trust: "UNTRUSTED",
      reason: input.hintResourceId
        ? `Device claims resource ${input.hintResourceId} but session active resource differs (or session ownership violation)`
        : `Resource hint rejected by validateResourceHint (session missing, ownership violation, or no active resource)`,
    };
  }

  // D. Per-device rate limiting.
  // Phase 10.1.1: Keyed by (deviceId, observedAt) on EdgeObservationRecord —
  // genuinely per-device. Two devices reporting on the same resource get
  // separate buckets. A device cannot evade the limit by switching resource
  // context. Counting observation RECORDS (not measurements) is correct
  // because suspicious observations that never project to a measurement
  // (e.g., resource mismatch) still count toward the device's rate limit.
  //
  // Phase 10.1.1 (off-by-one fix): The count is performed AFTER the
  // EdgeObservationRecord has been persisted in ingestOneObservation (step 5
  // creates the record, step 6 calls validateObservation). So the count
  // INCLUDES the current observation's own record.
  //
  //   Nth observation → count = N (includes itself)
  //
  // "max 60 per minute" means observations 1..60 are allowed (VALID), and the
  // 61st is the first to be classified RATE_LIMITED. Therefore the condition
  // is strictly-greater-than (>), NOT >=:
  //
  //   count = 60 → 60 > 60 = false → VALID    (60th observation, within limit)
  //   count = 61 → 61 > 60 = true  → RATE_LIMITED (61st, first to exceed)
  //
  // The previous `>=` condition fired at count=60, making the 60th observation
  // (which is within the limit) RATE_LIMITED — an off-by-one.
  const recentCount = await db.edgeObservationRecord.count({
    where: {
      deviceId: input.deviceId,
      observedAt: { gte: new Date(now - OBSERVATION_VALIDATION.rateLimitWindowMs) },
    },
  });
  if (recentCount > OBSERVATION_VALIDATION.maxObservationsPerMinute) {
    return {
      integrity: "RATE_LIMITED",
      trust: "UNTRUSTED",
      reason: `${recentCount} observations from device ${input.deviceId} in the last ${OBSERVATION_VALIDATION.rateLimitWindowMs / 1000}s (max ${OBSERVATION_VALIDATION.maxObservationsPerMinute}; the 61st in a 60s window is the first to be rate-limited)`,
    };
  }

  // All checks passed → VALID with default trust for the source
  return {
    integrity: "VALID",
    trust: defaultTrustForSource(input.source),
  };
}

// ---------------------------------------------------------------------------
// Metric plausibility validation
// ---------------------------------------------------------------------------

function validateMetrics(metrics: Record<string, unknown>): string | null {
  const down = asNumber(metrics.throughputDownMbps) ?? asNumber(metrics.currentDownloadMbps);
  const up = asNumber(metrics.throughputUpMbps) ?? asNumber(metrics.currentUploadMbps);
  const latency = asNumber(metrics.latencyMs);
  const loss = asNumber(metrics.packetLossPct) ?? asNumber(metrics.packetLossPercent);

  if (down !== undefined) {
    if (down < OBSERVATION_VALIDATION.minThroughputMbps || down > OBSERVATION_VALIDATION.maxThroughputMbps) {
      return `throughputDownMbps=${down} is outside valid range [${OBSERVATION_VALIDATION.minThroughputMbps}, ${OBSERVATION_VALIDATION.maxThroughputMbps}]`;
    }
  }
  if (up !== undefined) {
    if (up < OBSERVATION_VALIDATION.minThroughputMbps || up > OBSERVATION_VALIDATION.maxThroughputMbps) {
      return `throughputUpMbps=${up} is outside valid range`;
    }
  }
  if (latency !== undefined) {
    if (latency < OBSERVATION_VALIDATION.minLatencyMs || latency > OBSERVATION_VALIDATION.maxLatencyMs) {
      return `latencyMs=${latency} is outside valid range [${OBSERVATION_VALIDATION.minLatencyMs}, ${OBSERVATION_VALIDATION.maxLatencyMs}]`;
    }
  }
  if (loss !== undefined) {
    if (loss < 0 || loss > OBSERVATION_VALIDATION.maxPacketLossPct) {
      return `packetLossPct=${loss} is outside valid range [0, ${OBSERVATION_VALIDATION.maxPacketLossPct}]`;
    }
  }

  return null;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
