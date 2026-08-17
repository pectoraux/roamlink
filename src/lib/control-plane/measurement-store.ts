/**
 * Control Plane — Measurement Store / Ingestion (Phase 8.6.1 + 8.6.5)
 *
 * The single ingestion entry point for connectivity measurements. Makes
 * measurements first-class events with provenance and idempotent identity.
 *
 * Responsibilities:
 *   1. Validate `source` provenance (ADAPTER|DEVICE|PROBE|PROVIDER|DERIVED).
 *   2. Compute freshness from `capturedAt` at ingestion time and persist it.
 *   3. Phase 8.6.5: Idempotent write. Two probes of the same observation
 *      (resourceId, observedAt, source, metrics-hash) MUST NOT create two
 *      measurements. A deduplicationKey is computed (or caller-supplied) and
 *      enforced unique; P2002 races return the existing measurement.
 *   4. Derive + persist ResourceHealth (a rebuildable projection, NOT a second
 *      source of truth — see health-derivation.rebuildResourceHealth).
 *   5. Emit re-evaluation events (idempotent — deduped by idempotencyKey).
 *
 * Architecture:
 *   Provider Adapter → observation → ingestMeasurement → Measurement Store
 *        → Health Derivation → Decision Engine (via re-evaluation)
 *
 * Measurements are IMMUTABLE observations. ResourceHealth is a derived
 * projection. A decision is a consumer of the projection.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createHash } from "crypto";
import { classifyFreshness, DEFAULT_THRESHOLDS, type FreshnessThresholds } from "./freshness";
import { deriveResourceHealth, getResourceHealth, type HealthDerivationParams } from "./health-derivation";
import type { HealthStatus, MeasurementFreshness, MeasurementSource } from "@/lib/protocol";

// ---------------------------------------------------------------------------
// Valid sources (provenance) — enforced at ingestion
// ---------------------------------------------------------------------------

export const VALID_SOURCES: readonly MeasurementSource[] = [
  "ADAPTER",
  "DEVICE",
  "PROBE",
  "PROVIDER",
  "DERIVED",
] as const;

export function isValidSource(source: string): source is MeasurementSource {
  return (VALID_SOURCES as readonly string[]).includes(source);
}

// ---------------------------------------------------------------------------
// Ingestion input
// ---------------------------------------------------------------------------

export type IngestMeasurementInput = {
  resourceId?: string;
  sessionId?: string;
  providerInstanceId?: string;
  type: "USAGE" | "QUALITY" | "AVAILABILITY";
  metrics: Record<string, unknown>;
  source: MeasurementSource | string; // validated at runtime
  confidence?: number;
  capturedAt?: Date; // defaults to now
  // Phase 8.6.5: caller-supplied dedup identity. If omitted, computed from
  // (resourceId, capturedAt, source, metrics-hash). When two probes produce
  // the same logical observation, they collapse to one measurement.
  deduplicationKey?: string;
  // Optional derivation overrides (policy-driven)
  derivation?: HealthDerivationParams;
  thresholds?: FreshnessThresholds;
  // Whether to trigger synchronous re-evaluation (default true). Set false in
  // batch/worker contexts that process events separately.
  triggerReevaluation?: boolean;
  // Phase 10: Server-derived trust + integrity (optional — defaults to
  // TRUSTED/VALID for backward compatibility with adapter-sourced measurements).
  trust?: string;
  integrity?: string;
};

export type IngestResult = {
  measurementId: string;
  freshness: MeasurementFreshness;
  // Phase 8.6.5: true if this ingest was a no-op duplicate (existing measurement returned).
  duplicate: boolean;
  health: {
    resourceId: string;
    status: HealthStatus;
    quality: number;
    sampleCount: number;
    degradedCount: number;
  } | null;
  eventsEmitted: string[];
};

// ---------------------------------------------------------------------------
// Deduplication key computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic deduplication key from the observation identity:
 *   (resourceId, observedAt (ms), source, stable metrics hash)
 *
 * Two probes that observe the same resource at the same capturedAt with the
 * same source and same metrics produce the SAME key → one measurement.
 *
 * The metrics hash is order-stable (keys sorted) so semantically-equal metric
 * objects hash equally regardless of key insertion order.
 */
export function computeDeduplicationKey(input: {
  resourceId?: string;
  capturedAt: Date;
  source: MeasurementSource;
  metrics: Record<string, unknown>;
}): string {
  const resourceId = input.resourceId ?? "no-resource";
  const observedMs = input.capturedAt.getTime();
  const stableMetrics = JSON.stringify(input.metrics, Object.keys(input.metrics).sort());
  const hash = createHash("sha256")
    .update(`${resourceId}|${observedMs}|${input.source}|${stableMetrics}`)
    .digest("hex")
    .slice(0, 32);
  return `meas-${resourceId.slice(0, 12)}-${observedMs}-${hash}`;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Ingest a connectivity measurement (idempotent).
 *
 * @throws if `source` is not a valid provenance value.
 */
export async function ingestMeasurement(input: IngestMeasurementInput): Promise<IngestResult> {
  // 1. Validate provenance
  if (!isValidSource(input.source)) {
    throw new Error(
      `Invalid measurement source "${input.source}". Must be one of: ${VALID_SOURCES.join(", ")}. ` +
        `Provider-reported and client-observed metrics must preserve provenance.`,
    );
  }
  const source: MeasurementSource = input.source;

  // 2. Compute freshness from capturedAt
  const capturedAt = input.capturedAt ?? new Date();
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const freshness = classifyFreshness(capturedAt, new Date(), thresholds);

  // 3. Compute (or accept) the deduplication key
  const deduplicationKey =
    input.deduplicationKey ??
    computeDeduplicationKey({ resourceId: input.resourceId, capturedAt, source, metrics: input.metrics });

  // 4. Idempotent persist. Check-then-create with P2002 handling so two
  //    concurrent probes of the same observation collapse to one row.
  let measurement = await db.connectivityMeasurement.findUnique({
    where: { deduplicationKey },
  });
  let duplicate = false;

  if (measurement) {
    duplicate = true;
    logger.info("measurement.deduplicated", {
      measurementId: measurement.id,
      deduplicationKey,
      resourceId: input.resourceId,
    });
  } else {
    try {
      measurement = await db.connectivityMeasurement.create({
        data: {
          sessionId: input.sessionId ?? null,
          resourceId: input.resourceId ?? null,
          providerInstanceId: input.providerInstanceId ?? null,
          type: input.type,
          metrics: JSON.stringify(input.metrics),
          freshness,
          source,
          confidence: input.confidence ?? 0.5,
          capturedAt,
          deduplicationKey,
          // Phase 10: Persist trust + integrity classification
          trust: input.trust ?? "TRUSTED",
          integrity: input.integrity ?? "VALID",
        },
      });
    } catch (err: any) {
      // P2002: concurrent probe created the same measurement first.
      if (err?.code === "P2002") {
        measurement = await db.connectivityMeasurement.findUnique({
          where: { deduplicationKey },
        });
        if (measurement) {
          duplicate = true;
          logger.info("measurement.concurrent_deduplicated", {
            measurementId: measurement.id,
            deduplicationKey,
          });
        } else {
          throw err; // shouldn't happen, but fail loudly if it does
        }
      } else {
        throw err;
      }
    }
  }

  // Update the session's lastObservedAt if linked
  if (input.sessionId) {
    await db.connectivitySession
      .update({ where: { id: input.sessionId }, data: { lastObservedAt: new Date() } })
      .catch(() => {});
  }

  logger.info("measurement.ingested", {
    measurementId: measurement.id,
    resourceId: input.resourceId,
    sessionId: input.sessionId,
    source,
    freshness,
    type: input.type,
    duplicate,
  });

  const eventsEmitted: string[] = [];

  // 5. Derive health (only if a resourceId is linked AND this wasn't a duplicate).
  //    A duplicate measurement already derived health on its first ingest.
  let health: IngestResult["health"] = null;
  if (input.resourceId && !duplicate) {
    const previous = await getResourceHealth(input.resourceId);

    const derived = await deriveResourceHealth(input.resourceId, {
      ...input.derivation,
      thresholds,
    });
    health = {
      resourceId: derived.resourceId,
      status: derived.status,
      quality: derived.quality,
      sampleCount: derived.sampleCount,
      degradedCount: derived.degradedCount,
    };

    // 6. Emit idempotent re-evaluation events (deduped by idempotencyKey).
    const eventKeyPrefix = `evt-${deduplicationKey}`;
    await emitEvent({
      type: "MEASUREMENT_RECEIVED",
      resourceId: input.resourceId,
      sessionId: input.sessionId,
      idempotencyKey: `${eventKeyPrefix}-MR`,
      payload: { measurementId: measurement.id, source, freshness, type: input.type },
    });
    eventsEmitted.push("MEASUREMENT_RECEIVED");

    // Health transition events
    const prevStatus = previous?.status;
    const newStatus = derived.status;
    if (prevStatus !== newStatus) {
      if (newStatus === "DEGRADED" && prevStatus !== "DEGRADED") {
        await emitEvent({
          type: "RESOURCE_DEGRADED",
          resourceId: input.resourceId,
          sessionId: input.sessionId,
          idempotencyKey: `${eventKeyPrefix}-DG`,
          payload: {
            measurementId: measurement.id,
            previousStatus: prevStatus ?? "UNKNOWN",
            quality: derived.quality,
            degradedCount: derived.degradedCount,
            sampleCount: derived.sampleCount,
          },
        });
        eventsEmitted.push("RESOURCE_DEGRADED");
      } else if (newStatus === "HEALTHY" && prevStatus === "DEGRADED") {
        await emitEvent({
          type: "RESOURCE_RECOVERED",
          resourceId: input.resourceId,
          sessionId: input.sessionId,
          idempotencyKey: `${eventKeyPrefix}-RC`,
          payload: {
            measurementId: measurement.id,
            previousStatus: prevStatus,
            quality: derived.quality,
          },
        });
        eventsEmitted.push("RESOURCE_RECOVERED");
      }
    }

    // 7. Trigger synchronous re-evaluation (lazily imported to avoid static cycles)
    if (input.triggerReevaluation !== false) {
      try {
        const { processPendingEventsForResource } = await import("./reevaluation");
        await processPendingEventsForResource(input.resourceId);
      } catch (err) {
        // Re-evaluation failure must not roll back ingestion.
        logger.error("measurement.reevaluation_failed", {
          measurementId: measurement.id,
          resourceId: input.resourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { measurementId: measurement.id, freshness, duplicate, health, eventsEmitted };
}

// ---------------------------------------------------------------------------
// Event emission helper (idempotent — deduped by idempotencyKey)
// ---------------------------------------------------------------------------

async function emitEvent(input: {
  type: "MEASUREMENT_RECEIVED" | "RESOURCE_DEGRADED" | "RESOURCE_RECOVERED" | "QUOTA_THRESHOLD_REACHED" | "PROVIDER_UNAVAILABLE" | "LOCATION_CHANGED" | "POLICY_CHANGED";
  resourceId?: string;
  sessionId?: string;
  subjectId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  // Phase 8.6.5: if an idempotencyKey is supplied, check-then-create so a
  // duplicate emission is a no-op (not an error).
  if (input.idempotencyKey) {
    const existing = await db.reevaluationEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return; // already emitted — idempotent
    }
    try {
      await db.reevaluationEvent.create({
        data: {
          type: input.type,
          resourceId: input.resourceId ?? null,
          sessionId: input.sessionId ?? null,
          subjectId: input.subjectId ?? null,
          payload: JSON.stringify(input.payload),
          idempotencyKey: input.idempotencyKey,
          state: "PENDING",
        },
      });
    } catch (err: any) {
      // P2002: concurrent emission created it first — idempotent no-op.
      if (err?.code !== "P2002") throw err;
    }
    return;
  }

  // No idempotency key — always create (legacy/manual events).
  await db.reevaluationEvent.create({
    data: {
      type: input.type,
      resourceId: input.resourceId ?? null,
      sessionId: input.sessionId ?? null,
      subjectId: input.subjectId ?? null,
      payload: JSON.stringify(input.payload),
      state: "PENDING",
    },
  });
}
