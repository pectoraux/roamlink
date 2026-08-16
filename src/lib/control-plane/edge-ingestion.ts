/**
 * Control Plane — Edge Observation Ingestion (Phase 9.1)
 *
 * The server-side pipeline that ingests observations from mobile devices and
 * projects them into the existing control plane.
 *
 * Pipeline:
 *   authenticate (user)
 *     → authorize device/session ownership
 *     → validate schema
 *     → dedupe observationId + (deviceId, sequence)
 *     → persist immutable EdgeObservationRecord
 *     → project to ConnectivityMeasurement (source=DEVICE)
 *     → emit MEASUREMENT_RECEIVED (existing reevaluation path)
 *
 * Architectural constraint (FROZEN):
 *   The device NEVER submits a precomputed health score or decision.
 *   The server derives authoritative ConnectivityMeasurement and ResourceHealth.
 *   The device-supplied resourceId is a HINT — validated against the
 *   authenticated session's active resource.
 *
 *   EdgeObservation → Measurement → ResourceHealth → Reevaluation → Decision → Action
 *
 * The mobile edge must NEVER directly invoke:
 *   Decision Engine, Action Executor, Kernel, Adapter.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ingestMeasurement } from "./measurement-store";
import type {
  EdgeObservation,
  EdgeObservationBatch,
  EdgeObservationAck,
  EdgeDeviceContext,
  EdgeConnectivityState,
} from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Device registration (binds deviceId → authenticated user)
// ---------------------------------------------------------------------------

/**
 * Register or update an edge device. The deviceId is client-generated; the
 * server binds it to the authenticated userId. Subsequent observations from
 * this deviceId are validated against this ownership.
 */
export async function registerEdgeDevice(input: {
  userId: string;
  deviceId: string;
  platform: string;
  appVersion: string;
}): Promise<{ deviceId: string; registered: boolean }> {
  const existing = await db.edgeDevice.findUnique({ where: { deviceId: input.deviceId } });

  if (existing) {
    // Validate ownership — a device cannot be re-registered by a different user.
    if (existing.userId !== input.userId) {
      throw new Error(`Device ${input.deviceId} is registered to a different user — ownership violation`);
    }
    // Update lastSeen + version
    await db.edgeDevice.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date(), appVersion: input.appVersion, platform: input.platform },
    });
    return { deviceId: input.deviceId, registered: false };
  }

  await db.edgeDevice.create({
    data: {
      deviceId: input.deviceId,
      userId: input.userId,
      platform: input.platform,
      appVersion: input.appVersion,
    },
  });

  logger.info("edge.device_registered", { deviceId: input.deviceId, userId: input.userId });
  return { deviceId: input.deviceId, registered: true };
}

// ---------------------------------------------------------------------------
// Validate device ownership
// ---------------------------------------------------------------------------

/**
 * Validate that a deviceId belongs to the authenticated user. Throws if the
 * device is unknown or owned by a different user.
 */
export async function validateDeviceOwnership(userId: string, deviceId: string): Promise<void> {
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device) {
    throw new Error(`Unknown device: ${deviceId} — register the device first`);
  }
  if (device.userId !== userId) {
    throw new Error(`Device ${deviceId} does not belong to user ${userId} — impersonation blocked`);
  }
}

// ---------------------------------------------------------------------------
// Validate resourceId as a HINT (not authoritative)
// ---------------------------------------------------------------------------

/**
 * Validate the device-supplied resourceId hint against the authenticated
 * session's active resource. If the hint doesn't match, the observation is
 * still accepted (with resourceId cleared) — the device may be confused
 * about which resource it's on, but its connectivity observation is still
 * valid telemetry.
 *
 * Returns the validated resourceId (or null if the hint is invalid).
 */
export async function validateResourceHint(
  userId: string,
  sessionId: string | undefined,
  resourceIdHint: string | undefined,
): Promise<string | null> {
  if (!resourceIdHint) return null;

  // If we have a session, check its active resource
  if (sessionId) {
    const session = await db.connectivitySession.findUnique({
      where: { id: sessionId },
      select: { subjectId: true, activeResourceId: true, state: true },
    });

    if (!session) return null; // session doesn't exist — drop the hint

    // Validate session ownership
    if (session.subjectId !== userId) {
      logger.warn("edge.resource_hint_session_mismatch", { sessionId, userId, sessionSubject: session.subjectId });
      return null; // session belongs to another user — drop the hint
    }

    // If the hint matches the session's active resource, accept it
    if (session.activeResourceId === resourceIdHint) {
      return resourceIdHint;
    }

    // Hint doesn't match — accept the observation but clear the hint
    return null;
  }

  // No session — accept the hint only if the resource exists and belongs to
  // a capability owned by the user's tenant. This is a weaker validation.
  // For now, drop the hint if there's no session to validate against.
  return null;
}

// ---------------------------------------------------------------------------
// Validate session ownership
// ---------------------------------------------------------------------------

/**
 * Validate that a sessionId belongs to the authenticated user. Returns the
 * validated sessionId (or null if invalid).
 */
export async function validateSessionOwnership(
  userId: string,
  sessionId: string | undefined,
): Promise<string | null> {
  if (!sessionId) return null;

  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { subjectId: true, state: true },
  });

  if (!session) return null;
  if (session.subjectId !== userId) {
    logger.warn("edge.session_ownership_violation", { sessionId, userId, sessionSubject: session.subjectId });
    return null;
  }

  return sessionId;
}

// ---------------------------------------------------------------------------
// Project EdgeObservation → ConnectivityMeasurement metrics
// ---------------------------------------------------------------------------

/**
 * Convert an EdgeConnectivityState (device-reported) into the metrics object
 * expected by ConnectivityMeasurement. The server owns this projection — the
 * device never submits a precomputed measurement.
 */
function projectToMetrics(connectivity: EdgeConnectivityState, device?: EdgeDeviceContext): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    throughputDownMbps: connectivity.downlinkMbps,
    throughputUpMbps: connectivity.uplinkMbps,
    latencyMs: connectivity.latencyMs,
    packetLossPercent: connectivity.packetLossPct,
    signalQuality: connectivity.signalQuality,
    availability: connectivity.connected ? 1 : 0,
    isActive: connectivity.connected,
    transport: connectivity.transport,
  };

  if (device) {
    metrics.roaming = device.roaming;
    metrics.metered = device.metered;
    metrics.batteryState = device.batteryState;
    metrics.powerSaver = device.powerSaver;
  }

  // Strip undefined values
  for (const key of Object.keys(metrics)) {
    if (metrics[key] === undefined) delete metrics[key];
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Ingest a single observation
// ---------------------------------------------------------------------------

type IngestOneResult = {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
  measurementId?: string;
};

async function ingestOneObservation(
  userId: string,
  obs: EdgeObservation,
): Promise<IngestOneResult> {
  // 1. Schema validation
  if (!obs.observationId || !obs.deviceId || !obs.observedAt || obs.sequence === undefined) {
    return { accepted: false, duplicate: false, reason: "missing-required-field" };
  }
  if (obs.source !== "DEVICE" && obs.source !== "PROBE") {
    return { accepted: false, duplicate: false, reason: `invalid-source: ${obs.source}` };
  }
  if (!obs.connectivity || typeof obs.connectivity !== "object") {
    return { accepted: false, duplicate: false, reason: "missing-connectivity-state" };
  }

  // 2. Dedup on observationId (idempotent — duplicate uploads collapse)
  const existing = await db.edgeObservationRecord.findUnique({
    where: { observationId: obs.observationId },
    select: { id: true, derivedMeasurementId: true },
  });
  if (existing) {
    return { accepted: true, duplicate: true, measurementId: existing.derivedMeasurementId ?? undefined };
  }

  // 3. Dedup on (deviceId, sequence) — per-device sequence uniqueness
  const existingSeq = await db.edgeObservationRecord.findUnique({
    where: { deviceId_sequence: { deviceId: obs.deviceId, sequence: obs.sequence } },
    select: { id: true, observationId: true, derivedMeasurementId: true },
  });
  if (existingSeq) {
    // Same sequence, different observationId — still a duplicate (sequence is
    // the authoritative per-device order). Accept as duplicate.
    return { accepted: true, duplicate: true, measurementId: existingSeq.derivedMeasurementId ?? undefined };
  }

  // 4. Validate session + resource hints (never trust device-supplied identity)
  const validatedSessionId = await validateSessionOwnership(userId, obs.sessionId);
  const validatedResourceId = await validateResourceHint(userId, validatedSessionId ?? undefined, obs.resourceId);

  // 5. Persist the immutable observation record
  const record = await db.edgeObservationRecord.create({
    data: {
      observationId: obs.observationId,
      deviceId: obs.deviceId,
      userId,
      sessionId: validatedSessionId,
      resourceId: validatedResourceId,
      sequence: obs.sequence,
      source: obs.source,
      observedAt: new Date(obs.observedAt),
      payload: JSON.stringify(obs),
    },
  });

  // 6. Project to ConnectivityMeasurement (source=DEVICE) via the existing
  //    ingestion pipeline. This derives health + emits MEASUREMENT_RECEIVED.
  //    Only project if we have a validated resourceId — otherwise the
  //    observation is stored but doesn't feed the control plane (no resource
  //    to associate health with).
  let measurementId: string | undefined;
  if (validatedResourceId) {
    try {
      const result = await ingestMeasurement({
        resourceId: validatedResourceId,
        sessionId: validatedSessionId ?? undefined,
        type: "QUALITY",
        metrics: projectToMetrics(obs.connectivity, obs.device),
        source: "DEVICE", // provenance: device-reported
        confidence: 0.7, // device-reported is less trustworthy than adapter
        capturedAt: new Date(obs.observedAt),
        triggerReevaluation: true,
      });
      measurementId = result.measurementId;

      // Link the observation record to the derived measurement
      await db.edgeObservationRecord.update({
        where: { id: record.id },
        data: { derivedMeasurementId: measurementId },
      }).catch(() => {});
    } catch (err) {
      // Measurement ingestion failure must not roll back the observation.
      // The observation is still persisted (immutable log).
      logger.error("edge.measurement_projection_failed", {
        observationId: obs.observationId, resourceId: validatedResourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { accepted: true, duplicate: false, measurementId };
}

// ---------------------------------------------------------------------------
// Ingest a batch (the HTTP endpoint entry point)
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of edge observations. Dedupes by observationId and
 * (deviceId, sequence). Returns an ack with the accepted sequence watermark.
 *
 * @param userId Authenticated user (from session cookie)
 * @param batch  The batch from the device
 */
export async function ingestEdgeObservationBatch(
  userId: string,
  batch: EdgeObservationBatch,
): Promise<EdgeObservationAck> {
  // Validate device ownership (all observations must come from a device
  // registered to this user)
  await validateDeviceOwnership(userId, batch.deviceId);

  // Validate all observations belong to this device
  for (const obs of batch.observations) {
    if (obs.deviceId !== batch.deviceId) {
      throw new Error(`Observation ${obs.observationId} has deviceId ${obs.deviceId} but batch deviceId is ${batch.deviceId} — impersonation blocked`);
    }
  }

  let acceptedThroughSequence = 0;
  let duplicateCount = 0;
  const rejected: EdgeObservationAck["rejected"] = [];

  for (const obs of batch.observations) {
    try {
      const result = await ingestOneObservation(userId, obs);
      if (result.accepted) {
        if (result.duplicate) {
          duplicateCount++;
        }
        // Track the highest accepted sequence in this batch. The client uses
        // this to delete acknowledged observations from its outbox: any
        // observation with sequence <= acceptedThroughSequence is safely
        // persisted server-side (or was a duplicate that's already there).
        if (obs.sequence > acceptedThroughSequence) {
          acceptedThroughSequence = obs.sequence;
        }
      } else {
        rejected.push({ observationId: obs.observationId, reason: result.reason ?? "unknown" });
      }
    } catch (err) {
      rejected.push({
        observationId: obs.observationId,
        reason: err instanceof Error ? err.message.slice(0, 100) : "error",
      });
    }
  }

  // If this batch had duplicates but no new acceptances, report the max
  // sequence from the duplicates so the client can clean them up.
  if (acceptedThroughSequence === 0 && duplicateCount > 0) {
    for (const obs of batch.observations) {
      if (obs.sequence > acceptedThroughSequence) {
        acceptedThroughSequence = obs.sequence;
      }
    }
  }

  // Update device lastSeen
  await db.edgeDevice.update({
    where: { deviceId: batch.deviceId },
    data: { lastSeenAt: new Date() },
  }).catch(() => {});

  logger.info("edge.batch_ingested", {
    deviceId: batch.deviceId, userId,
    count: batch.observations.length,
    acceptedThroughSequence, duplicateCount, rejected: rejected.length,
  });

  return {
    acceptedThroughSequence,
    duplicateCount,
    rejected,
    serverTime: new Date().toISOString(),
  };
}
