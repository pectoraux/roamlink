/**
 * Control Plane — Health Derivation (Phase 8.6.3)
 *
 * Turns the persisted measurement stream into a derived, persisted
 * ResourceHealth snapshot. This makes hysteresis a genuine control-system
 * property: health is queryable, auditable, and event-addressable — not
 * recomputed ad hoc inside the decision engine.
 *
 *   last N measurements (within window, EXPIRED excluded)
 *         │
 *         ▼
 *   per-sample quality derivation  (normalized 0–1)
 *         │
 *         ▼
 *   M-of-N degraded  →  status = DEGRADED
 *         │
 *         ▼
 *   persisted ResourceHealth { status, quality, sampleCount, degradedCount, freshness }
 *         │
 *         ▼
 *   decision engine consults the snapshot
 *
 * The decision engine READS the persisted snapshot; it does not recompute.
 * Derivation is triggered by the ingestion layer (measurement-store).
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { classifyFreshness, contributesToHealth, DEFAULT_THRESHOLDS, type FreshnessThresholds } from "./freshness";
import type { HealthStatus, MeasurementFreshness } from "@/lib/protocol";

// ---------------------------------------------------------------------------
// Derivation parameters (defaults; policy-overridable in future)
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_MS = 5 * 60_000; // consider measurements up to 5 min old
export const DEFAULT_SAMPLE_N = 5; // last N measurements
export const DEFAULT_DEGRADED_THRESHOLD = 0.4; // quality below this = degraded sample
export const DEFAULT_MIN_DEGRADED_COUNT = 2; // M-of-N: at least 2 degraded → DEGRADED

/**
 * Phase 10.1.1 — Two distinct time windows (intentionally documented).
 *
 *   1. INGESTION ACCEPTANCE WINDOW  (OBSERVATION_VALIDATION.maxAgeMs)
 *      Gate at the edge-ingestion boundary. An observation older than this is
 *      classified STALE + UNTRUSTED at ingestion and stored for audit, but the
 *      trust firewall excludes it from health derivation.
 *
 *   2. HEALTH CONTRIBUTION WINDOW  (DEFAULT_WINDOW_MS — this file)
 *      Gate inside deriveResourceHealth(). Determines which ACCEPTED
 *      measurements contribute to the CURRENT health snapshot. Finer-grained
 *      than the ingestion window: the freshness classification (FRESH/STALE/
 *      EXPIRED) is derived from capturedAt at read time and excludes EXPIRED
 *      samples from the snapshot.
 *
 * These are different policies and MUST NOT be collapsed into one. The
 * ingestion window is an acceptance/audit boundary; the health window is a
 * control-plane authority boundary. Future agents: do not "simplify" one into
 * the other — doing so would couple audit policy to decision policy.
 */

export type HealthDerivationParams = {
  windowMs?: number;
  sampleN?: number;
  degradedThreshold?: number;
  minDegradedCount?: number;
  thresholds?: FreshnessThresholds;
  now?: Date;
};

// ---------------------------------------------------------------------------
// Per-sample quality derivation (normalized 0–1)
// ---------------------------------------------------------------------------

/**
 * Derive a normalized quality score (0–1) for a single measurement.
 *
 * Combines throughput, latency, and packet loss when available. Higher is
 * better. A sample with no usable metrics scores 0.3 (unknown-but-present),
 * matching the prior decision-engine convention.
 */
export function deriveSampleQuality(metrics: Record<string, unknown>): number {
  const throughputDown = asNumber(metrics.throughputDownMbps) ?? asNumber(metrics.currentDownloadMbps);
  const latencyMs = asNumber(metrics.latencyMs);
  const packetLossPct = asNumber(metrics.packetLossPercent);
  const availability = asNumber(metrics.availability);

  // If availability is explicitly 0, quality is 0.
  if (availability !== undefined && availability <= 0) return 0;

  let score: number | null = null;

  // Throughput: 50 Mbps → 1.0 (capped)
  if (throughputDown !== undefined && throughputDown >= 0) {
    const t = Math.min(1, throughputDown / 50);
    score = score === null ? t : (score + t) / 2;
  }

  // Latency: 0ms → 1.0, 300ms → 0.0 (linear, clamped)
  if (latencyMs !== undefined && latencyMs >= 0) {
    const l = Math.max(0, 1 - latencyMs / 300);
    score = score === null ? l : (score + l) / 2;
  }

  // Packet loss: 0% → 1.0, 10% → 0.0 (linear, clamped)
  if (packetLossPct !== undefined && packetLossPct >= 0) {
    const p = Math.max(0, 1 - packetLossPct / 10);
    score = score === null ? p : (score + p) / 2;
  }

  if (score === null) return 0.3; // present but no usable metrics
  return Math.max(0, Math.min(1, score));
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Derive + persist ResourceHealth
// ---------------------------------------------------------------------------

export type DerivedHealth = {
  resourceId: string;
  status: HealthStatus;
  quality: number;
  sampleCount: number;
  degradedCount: number;
  freshness: MeasurementFreshness;
  derivedFromSources: string;
  latestMeasurementId: string | null;
  // Phase 10: Trust level of the evidence that fed this snapshot.
  trust: "TRUSTED" | "LIMITED" | "UNTRUSTED";
};

/**
 * Derive the health of a resource from its measurement stream and persist it
 * as a ResourceHealth snapshot (upsert by resourceId).
 *
 * EXPIRED measurements are excluded. UNKNOWN-freshness measurements are also
 * excluded (they carry no usable recency signal).
 *
 * Returns the derived snapshot.
 */
export async function deriveResourceHealth(
  resourceId: string,
  params: HealthDerivationParams = {},
): Promise<DerivedHealth> {
  const {
    windowMs = DEFAULT_WINDOW_MS,
    sampleN = DEFAULT_SAMPLE_N,
    degradedThreshold = DEFAULT_DEGRADED_THRESHOLD,
    minDegradedCount = DEFAULT_MIN_DEGRADED_COUNT,
    thresholds = DEFAULT_THRESHOLDS,
    now = new Date(),
  } = params;

  const windowStart = new Date(now.getTime() - windowMs);

  // Fetch the last N measurements within the window, newest first.
  const measurements = await db.connectivityMeasurement.findMany({
    where: {
      resourceId,
      capturedAt: { gte: windowStart },
    },
    orderBy: { capturedAt: "desc" },
    take: sampleN,
  });

  if (measurements.length === 0) {
    const snapshot = await persistHealth({
      resourceId,
      status: "UNKNOWN",
      quality: 0,
      sampleCount: 0,
      degradedCount: 0,
      freshness: "UNKNOWN",
      derivedFromSources: "",
      latestMeasurementId: null,
      trust: "UNTRUSTED",
    });
    return snapshot;
  }

  // Phase 10: Trust firewall. Filter out UNTRUSTED measurements — they are
  // stored for audit but must NOT influence health derivation.
  // Also filter EXPIRED / UNKNOWN-freshness samples.
  const contributing = measurements.filter((m) => {
    // Phase 10: Trust firewall — UNTRUSTED measurements excluded
    if (m.trust === "UNTRUSTED") return false;
    const f = classifyFreshness(m.capturedAt, now, thresholds);
    return contributesToHealth(f);
  });

  if (contributing.length === 0) {
    const snapshot = await persistHealth({
      resourceId,
      status: "UNKNOWN",
      quality: 0,
      sampleCount: 0,
      degradedCount: 0,
      freshness: "EXPIRED",
      derivedFromSources: "",
      latestMeasurementId: measurements[0]?.id ?? null,
      trust: "UNTRUSTED",
    });
    return snapshot;
  }

  // Per-sample quality + degraded count (M-of-N)
  const samples = contributing.map((m) => {
    const metrics = JSON.parse(m.metrics) as Record<string, unknown>;
    const quality = deriveSampleQuality(metrics);
    const freshness = classifyFreshness(m.capturedAt, now, thresholds);
    return { id: m.id, quality, freshness, source: m.source };
  });

  const degradedCount = samples.filter((s) => s.quality < degradedThreshold).length;
  const avgQuality = samples.reduce((sum, s) => sum + s.quality, 0) / samples.length;

  // M-of-N degraded → DEGRADED. Otherwise HEALTHY.
  const status: HealthStatus = degradedCount >= minDegradedCount ? "DEGRADED" : "HEALTHY";

  // The freshness of the snapshot = freshness of the most recent contributing sample.
  const freshness = samples[0]?.freshness ?? "UNKNOWN";

  // Provenance mix (deduplicated, joined with '+').
  const sourceSet = new Set(samples.map((s) => s.source).filter(Boolean));
  const derivedFromSources = Array.from(sourceSet).sort().join("+");

  // Phase 10: Derive trust from the contributing samples.
  // TRUSTED = at least one TRUSTED (provider/server) measurement contributed.
  // LIMITED = only LIMITED-trust (device) measurements contributed.
  // UNTRUSTED = no eligible measurements (shouldn't happen here, but defensive).
  const hasTrusted = contributing.some((m) => m.trust === "TRUSTED");
  const hasLimited = contributing.some((m) => m.trust === "LIMITED");
  const trustLevel: "TRUSTED" | "LIMITED" | "UNTRUSTED" = hasTrusted ? "TRUSTED" : hasLimited ? "LIMITED" : "UNTRUSTED";

  const snapshot = await persistHealth({
    resourceId,
    status,
    quality: Math.round(avgQuality * 1000) / 1000,
    sampleCount: samples.length,
    degradedCount,
    freshness,
    derivedFromSources,
    latestMeasurementId: samples[0]?.id ?? null,
    trust: trustLevel,
  });

  logger.info("health.derived", {
    resourceId,
    status,
    quality: snapshot.quality,
    sampleCount: samples.length,
    degradedCount,
    freshness,
    sources: derivedFromSources,
  });

  return snapshot;
}

// ---------------------------------------------------------------------------
// Persist (upsert by resourceId)
// ---------------------------------------------------------------------------

async function persistHealth(input: {
  resourceId: string;
  status: HealthStatus;
  quality: number;
  sampleCount: number;
  degradedCount: number;
  freshness: MeasurementFreshness;
  derivedFromSources: string;
  latestMeasurementId: string | null;
  trust: "TRUSTED" | "LIMITED" | "UNTRUSTED";
}): Promise<DerivedHealth> {
  await db.resourceHealth.upsert({
    where: { resourceId: input.resourceId },
    create: {
      resourceId: input.resourceId,
      status: input.status,
      quality: input.quality,
      sampleCount: input.sampleCount,
      degradedCount: input.degradedCount,
      freshness: input.freshness,
      derivedFromSources: input.derivedFromSources || null,
      latestMeasurementId: input.latestMeasurementId,
      trust: input.trust,
    },
    update: {
      status: input.status,
      quality: input.quality,
      sampleCount: input.sampleCount,
      degradedCount: input.degradedCount,
      freshness: input.freshness,
      derivedFromSources: input.derivedFromSources || null,
      latestMeasurementId: input.latestMeasurementId,
      trust: input.trust,
    },
  });

  return {
    resourceId: input.resourceId,
    status: input.status,
    quality: input.quality,
    sampleCount: input.sampleCount,
    degradedCount: input.degradedCount,
    freshness: input.freshness,
    derivedFromSources: input.derivedFromSources,
    latestMeasurementId: input.latestMeasurementId,
    trust: input.trust,
  };
}

// ---------------------------------------------------------------------------
// Read the persisted snapshot (used by the decision engine)
// ---------------------------------------------------------------------------

export async function getResourceHealth(resourceId: string): Promise<DerivedHealth | null> {
  const row = await db.resourceHealth.findUnique({ where: { resourceId } });
  if (!row) return null;
  return {
    resourceId: row.resourceId,
    status: row.status as HealthStatus,
    quality: row.quality,
    sampleCount: row.sampleCount,
    degradedCount: row.degradedCount,
    freshness: row.freshness as MeasurementFreshness,
    derivedFromSources: row.derivedFromSources ?? "",
    latestMeasurementId: row.latestMeasurementId,
    trust: (row.trust ?? "UNTRUSTED") as "TRUSTED" | "LIMITED" | "UNTRUSTED",
  };
}

// ---------------------------------------------------------------------------
// Phase 8.6.5: Rebuild — ResourceHealth is a PROJECTION, not a source of truth
// ---------------------------------------------------------------------------

/**
 * Rebuild the ResourceHealth snapshot for a resource from its measurement
 * stream, deterministically.
 *
 * Invariant:
 *   delete ResourceHealth → replay measurements → same health state
 *
 * This guarantees ResourceHealth never becomes a second hidden state machine:
 * it is always safely reconstructable from the immutable measurement log.
 * The rebuild deletes the existing snapshot and re-derives from measurements,
 * so the result is identical to what deriveResourceHealth() would produce
 * given the same measurement set and parameters.
 *
 * Returns the rebuilt snapshot.
 */
export async function rebuildResourceHealth(
  resourceId: string,
  params: HealthDerivationParams = {},
): Promise<DerivedHealth> {
  // Delete the existing projection (measurements are NOT deleted — they are
  // the immutable source of truth).
  await db.resourceHealth.deleteMany({ where: { resourceId } }).catch(() => {});

  // Re-derive from the measurement stream. deriveResourceHealth upserts the
  // snapshot, so this recreates it deterministically.
  return deriveResourceHealth(resourceId, params);
}

/**
 * Phase 8.6.5: Verify the projection invariant at runtime — rebuilding a
 * resource's health from its measurements must yield the same status, quality,
 * and counts as the current persisted snapshot.
 *
 * Used by the runtime test to prove ResourceHealth is a true projection.
 */
export async function verifyProjectionInvariant(
  resourceId: string,
  params: HealthDerivationParams = {},
): Promise<{ matches: boolean; before: DerivedHealth | null; after: DerivedHealth | null }> {
  const before = await getResourceHealth(resourceId);
  const after = await rebuildResourceHealth(resourceId, params);

  if (!before) {
    return { matches: after === null, before, after };
  }
  if (!after) {
    return { matches: false, before, after };
  }

  const matches =
    before.status === after.status &&
    Math.abs(before.quality - after.quality) < 0.001 &&
    before.sampleCount === after.sampleCount &&
    before.degradedCount === after.degradedCount;

  return { matches, before, after };
}
