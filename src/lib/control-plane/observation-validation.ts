/**
 * Phase 10 — Observation Validation & Trust Derivation
 *
 * Validates incoming edge observations and derives server-side trust/integrity
 * classification. The server alone derives trust — the mobile client never
 * submits trust.
 *
 *   Device telemetry is evidence, not authority.
 *
 * Validation checks:
 *   A. capturedAt sanity window (STALE / FUTURE_TIMESTAMP)
 *   B. Impossible metric values (INVALID_METRIC)
 *   C. Resource/session consistency (RESOURCE_MISMATCH)
 *   D. Rate limiting (RATE_LIMITED)
 *
 * Suspicious observations are NOT deleted — they are persisted with their
 * integrity classification so they remain auditable.
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

  // C. Resource/session consistency (if sessionId provided)
  if (input.sessionId && input.resourceId) {
    const session = await db.connectivitySession.findUnique({
      where: { id: input.sessionId },
      select: { activeResourceId: true, subjectId: true },
    });
    if (session && session.activeResourceId && session.activeResourceId !== input.resourceId) {
      return {
        integrity: "RESOURCE_MISMATCH",
        trust: "UNTRUSTED",
        reason: `Device claims resource ${input.resourceId} but session active resource is ${session.activeResourceId}`,
      };
    }
  }

  // D. Rate limiting
  const recentCount = await db.connectivityMeasurement.count({
    where: {
      resourceId: input.resourceId ?? undefined,
      capturedAt: { gte: new Date(now - 60_000) },
      source: input.source as string,
    },
  });
  if (recentCount >= OBSERVATION_VALIDATION.maxObservationsPerMinute) {
    return {
      integrity: "RATE_LIMITED",
      trust: "UNTRUSTED",
      reason: `${recentCount} observations in the last minute (max ${OBSERVATION_VALIDATION.maxObservationsPerMinute})`,
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
