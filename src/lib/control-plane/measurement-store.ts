/**
 * Control Plane — Measurement Store / Ingestion (Phase 8.6.1)
 *
 * The single ingestion entry point for connectivity measurements. Makes
 * measurements first-class events with provenance.
 *
 * Responsibilities:
 *   1. Validate `source` provenance (ADAPTER|DEVICE|PROBE|PROVIDER|DERIVED).
 *      Unknown sources are rejected — provider-reported and client-observed
 *      metrics are never mixed without preserving which is which.
 *   2. Compute freshness from `capturedAt` at ingestion time and persist it.
 *   3. Persist the ConnectivityMeasurement.
 *   4. Derive + persist ResourceHealth (via health-derivation).
 *   5. Emit re-evaluation events (MEASUREMENT_RECEIVED, and on health
 *      transitions: RESOURCE_DEGRADED / RESOURCE_RECOVERED).
 *   6. Trigger synchronous re-evaluation of any affected active session.
 *
 * Architecture:
 *   Provider Adapter → observation → ingestMeasurement → Measurement Store
 *        → Health Derivation → Decision Engine (via re-evaluation)
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
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
  // Optional derivation overrides (policy-driven)
  derivation?: HealthDerivationParams;
  thresholds?: FreshnessThresholds;
  // Whether to trigger synchronous re-evaluation (default true). Set false in
  // batch/worker contexts that process events separately.
  triggerReevaluation?: boolean;
};

export type IngestResult = {
  measurementId: string;
  freshness: MeasurementFreshness;
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
// Ingest
// ---------------------------------------------------------------------------

/**
 * Ingest a connectivity measurement.
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

  // 3. Persist the measurement
  const measurement = await db.connectivityMeasurement.create({
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
    },
  });

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
  });

  const eventsEmitted: string[] = [];

  // 4. Derive health (only if a resourceId is linked)
  let health: IngestResult["health"] = null;
  if (input.resourceId) {
    // Capture the previous status to detect transitions
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

    // 5. Emit re-evaluation events
    // MEASUREMENT_RECEIVED is always emitted for a resource-linked measurement.
    await emitEvent({
      type: "MEASUREMENT_RECEIVED",
      resourceId: input.resourceId,
      sessionId: input.sessionId,
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
          payload: {
            measurementId: measurement.id,
            previousStatus: prevStatus,
            quality: derived.quality,
          },
        });
        eventsEmitted.push("RESOURCE_RECOVERED");
      }
    }

    // 6. Trigger synchronous re-evaluation (lazily imported to avoid static cycles)
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

  return { measurementId: measurement.id, freshness, health, eventsEmitted };
}

// ---------------------------------------------------------------------------
// Event emission helper
// ---------------------------------------------------------------------------

async function emitEvent(input: {
  type: "MEASUREMENT_RECEIVED" | "RESOURCE_DEGRADED" | "RESOURCE_RECOVERED" | "QUOTA_THRESHOLD_REACHED" | "PROVIDER_UNAVAILABLE" | "LOCATION_CHANGED" | "POLICY_CHANGED";
  resourceId?: string;
  sessionId?: string;
  subjectId?: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await db.reevaluationEvent.create({
    data: {
      type: input.type,
      resourceId: input.resourceId ?? null,
      sessionId: input.sessionId ?? null,
      subjectId: input.subjectId ?? null,
      payload: JSON.stringify(input.payload),
    },
  });
}
