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
 * Result of validating a device-supplied resourceId hint.
 *
 * Phase 10.1.1: The mismatch signal is preserved so the caller can persist
 * a measurement with integrity=RESOURCE_MISMATCH + trust=UNTRUSTED against
 * the session's actual active resource (not the bogus hint). The measurement
 * remains auditable; the health firewall excludes UNTRUSTED from derivation.
 */
export type ResourceHintValidation = {
  /** The resource to attach the projected measurement to (null if no session/no active resource). */
  validatedResourceId: string | null;
  /** True iff the device supplied a hint that doesn't match the session's active resource. */
  mismatch: boolean;
  /** The session's actual active resource (null if no session/no active resource). */
  sessionActiveResourceId: string | null;
  /** The original hint supplied by the device (null if absent). */
  hintResourceId: string | null;
  /** Reason the hint was rejected (for audit logging). */
  reason?: string;
};

/**
 * Validate the device-supplied resourceId hint against the authenticated
 * session's active resource.
 *
 * Phase 10.1.1: The mismatch is preserved as a signal — the caller uses it to
 * classify the projected measurement as RESOURCE_MISMATCH + UNTRUSTED. We do
 * NOT silently clear the hint and pretend the observation was clean.
 *
 *   hint matches session.activeResourceId → validatedResourceId = hint, mismatch = false
 *   hint mismatches session.activeResourceId → validatedResourceId = session.activeResourceId,
 *                                           mismatch = true (caller classifies UNTRUSTED)
 *   no session, no hint                   → validatedResourceId = null, mismatch = false
 *   session ownership violation          → validatedResourceId = null, mismatch = true
 *                                           (caller classifies UNTRUSTED — impersonation attempt)
 */
export async function validateResourceHint(
  userId: string,
  sessionId: string | null,
  resourceIdHint: string | undefined,
): Promise<ResourceHintValidation> {
  const hintResourceId = resourceIdHint ?? null;

  // No session — nothing to validate against. The hint is dropped (we cannot
  // confidently attach the measurement to any resource).
  if (!sessionId) {
    return { validatedResourceId: null, mismatch: false, sessionActiveResourceId: null, hintResourceId };
  }

  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { subjectId: true, activeResourceId: true, state: true },
  });

  // Session doesn't exist — drop the hint. Mismatch = true if the device
  // claimed a resource (the session reference itself is invalid).
  if (!session) {
    return {
      validatedResourceId: null,
      mismatch: hintResourceId !== null,
      sessionActiveResourceId: null,
      hintResourceId,
      reason: `session ${sessionId} does not exist`,
    };
  }

  // Session belongs to another user — impersonation attempt. Classify as
  // mismatch (UNTRUSTED) so the observation is auditable but excluded from health.
  if (session.subjectId !== userId) {
    logger.warn("edge.resource_hint_session_mismatch", { sessionId, userId, sessionSubject: session.subjectId });
    return {
      validatedResourceId: null,
      mismatch: true,
      sessionActiveResourceId: session.activeResourceId,
      hintResourceId,
      reason: `session ${sessionId} belongs to another user`,
    };
  }

  // No active resource on the session — can't attach the measurement.
  if (!session.activeResourceId) {
    return {
      validatedResourceId: null,
      mismatch: hintResourceId !== null,
      sessionActiveResourceId: null,
      hintResourceId,
      reason: `session ${sessionId} has no active resource`,
    };
  }

  // Hint matches → accept it.
  if (hintResourceId && hintResourceId === session.activeResourceId) {
    return {
      validatedResourceId: hintResourceId,
      mismatch: false,
      sessionActiveResourceId: session.activeResourceId,
      hintResourceId,
    };
  }

  // Hint mismatches (or is absent while a session has an active resource).
  // Attach the measurement to the SESSION'S active resource (not the hint),
  // and flag the mismatch so the caller classifies RESOURCE_MISMATCH + UNTRUSTED.
  // If the hint is absent, mismatch = false (the device simply didn't claim a resource).
  const mismatch = hintResourceId !== null;
  return {
    validatedResourceId: mismatch ? session.activeResourceId : null,
    mismatch,
    sessionActiveResourceId: session.activeResourceId,
    hintResourceId,
    reason: mismatch
      ? `device claims resource ${hintResourceId} but session active resource is ${session.activeResourceId}`
      : undefined,
  };
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

  // 4. Validate session + resource hints (never trust device-supplied identity).
  // Phase 10.1.1: validateResourceHint now returns a structured result that
  // preserves the mismatch signal — the caller classifies it as
  // RESOURCE_MISMATCH + UNTRUSTED instead of silently clearing the hint.
  const validatedSessionId = await validateSessionOwnership(userId, obs.sessionId);
  const resourceHint = await validateResourceHint(userId, validatedSessionId, obs.resourceId);

  // The resource to attach the projected measurement to. When the hint
  // mismatches, we attach to the session's actual active resource (not the
  // bogus hint) and mark the measurement UNTRUSTED so the health firewall
  // excludes it.
  const measurementResourceId = resourceHint.validatedResourceId;

  // 5. Persist the immutable observation record.
  // Phase 9.1.1: Handle P2002 (unique constraint) on concurrent create —
  // two requests with the same (deviceId, sequence) can both pass the check
  // above and race to create. The loser gets P2002 and is treated as a duplicate.
  //
  // The observation record stores the VALIDATED resource (null on mismatch
  // when there's no session, or the session's active resource when there is).
  // The mismatch is preserved on the projected measurement's integrity field.
  let record;
  try {
    record = await db.edgeObservationRecord.create({
      data: {
        observationId: obs.observationId,
        deviceId: obs.deviceId,
        userId,
        sessionId: validatedSessionId,
        resourceId: measurementResourceId,
        sequence: obs.sequence,
        source: obs.source,
        observedAt: new Date(obs.observedAt),
        payload: JSON.stringify(obs),
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Concurrent create race — the other request won. Treat as duplicate.
      const existing = await db.edgeObservationRecord.findUnique({
        where: { deviceId_sequence: { deviceId: obs.deviceId, sequence: obs.sequence } },
        select: { derivedMeasurementId: true },
      }).catch(() => null);
      return { accepted: true, duplicate: true, measurementId: existing?.derivedMeasurementId ?? undefined };
    }
    throw err;
  }

  // 6. Phase 10: Validate the observation and derive trust/integrity.
  //    The server alone derives trust — the mobile client never submits trust.
  //    Validation checks: capturedAt sanity, metric plausibility, resource
  //    consistency (incl. hint mismatch), per-device rate limiting.
  //
  //    Phase 10.1.1: We always run validation when there's a resource to
  //    attach to — including when the hint mismatches. The mismatch is
  //    classified as RESOURCE_MISMATCH + UNTRUSTED and persisted on the
  //    measurement so it remains auditable (the health firewall excludes it).
  let measurementId: string | undefined;
  if (measurementResourceId) {
    try {
      const { validateObservation } = await import("./observation-validation");
      const validationResult = await validateObservation({
        deviceId: obs.deviceId,
        resourceId: measurementResourceId,
        sessionId: validatedSessionId,
        hintResourceId: resourceHint.hintResourceId,
        resourceMismatch: resourceHint.mismatch,
        userId,
        observedAt: new Date(obs.observedAt),
        source: obs.source as any,
        metrics: projectToMetrics(obs.connectivity, obs.device),
      });

      // Log suspicious observations for auditability (they're still persisted)
      if (validationResult.integrity !== "VALID") {
        logger.warn("edge.observation_validation_failed", {
          observationId: obs.observationId,
          deviceId: obs.deviceId,
          integrity: validationResult.integrity,
          trust: validationResult.trust,
          reason: validationResult.reason,
        });
      }

      // 7. Project to ConnectivityMeasurement with trust/integrity classification.
      //    UNTRUSTED measurements are stored but excluded from health derivation
      //    by the health firewall (isEligibleForHealth).
      //
      //    Phase 10.1.1: triggerReevaluation is true for the device ingestion
      //    path (each device observation is a fresh signal). The previous code
      //    referenced an undefined `input` identifier — a regression introduced
      //    in Phase 10 that silently swallowed the ReferenceError in the
      //    try/catch below, so measurements were never projected.
      const result = await ingestMeasurement({
        resourceId: measurementResourceId,
        sessionId: validatedSessionId ?? undefined,
        type: "QUALITY",
        metrics: projectToMetrics(obs.connectivity, obs.device),
        source: "DEVICE",
        confidence: 0.7,
        capturedAt: new Date(obs.observedAt),
        triggerReevaluation: true,
        // Phase 10: Pass server-derived trust + integrity
        trust: validationResult.trust,
        integrity: validationResult.integrity,
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
        observationId: obs.observationId, resourceId: measurementResourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { accepted: true, duplicate: false, measurementId };
}

// ---------------------------------------------------------------------------
// Phase 9.1.1: Compute contiguous-through sequence watermark
// ---------------------------------------------------------------------------

/**
 * Compute the highest sequence number N such that all sequences 1..N are
 * persisted for this device. This is the "contiguous-through" watermark:
 * the client can safely delete any observation with sequence <= N from its
 * outbox, because the server has every sequence up to and including N.
 *
 * If there's a gap (e.g., 101 and 103 persisted but 102 missing), the
 * watermark is 101 — NOT 103. This prevents the client from deleting 102
 * (which the server never received).
 *
 * If no observations exist, returns 0.
 */
async function computeContiguousThroughSequence(deviceId: string): Promise<number> {
  // Fetch all persisted sequences for this device, sorted ascending.
  const records = await db.edgeObservationRecord.findMany({
    where: { deviceId },
    select: { sequence: true },
    orderBy: { sequence: "asc" },
  });

  if (records.length === 0) return 0;

  // Find the highest contiguous prefix starting from sequence 1.
  // (Sequence numbers are 1-based per device.)
  let expected = 1;
  for (const record of records) {
    if (record.sequence === expected) {
      expected++;
    } else if (record.sequence > expected) {
      // Gap found — the watermark is expected - 1
      break;
    }
    // If record.sequence < expected, it's a duplicate (already counted) — skip.
  }

  return expected - 1;
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

  // Track per-sequence outcomes for contiguous-through computation.
  const sequenceOutcomes = new Map<number, "accepted" | "duplicate" | "rejected">();
  let duplicateCount = 0;
  const rejected: EdgeObservationAck["rejected"] = [];

  for (const obs of batch.observations) {
    try {
      const result = await ingestOneObservation(userId, obs);
      if (result.accepted) {
        if (result.duplicate) {
          duplicateCount++;
          sequenceOutcomes.set(obs.sequence, "duplicate");
        } else {
          sequenceOutcomes.set(obs.sequence, "accepted");
        }
      } else {
        sequenceOutcomes.set(obs.sequence, "rejected");
        rejected.push({ observationId: obs.observationId, reason: result.reason ?? "unknown" });
      }
    } catch (err) {
      sequenceOutcomes.set(obs.sequence, "rejected");
      rejected.push({
        observationId: obs.observationId,
        reason: err instanceof Error ? err.message.slice(0, 100) : "error",
      });
    }
  }

  // Phase 9.1.1: Compute acceptedThroughSequence as the highest CONTIGUOUS
  // accepted prefix. The client uses this to safely delete observations from
  // its outbox: any observation with sequence <= acceptedThroughSequence is
  // safely persisted server-side (or was a duplicate that's already there).
  //
  // If 101 accepted, 102 rejected, 103 accepted, the watermark is 101 — NOT 103.
  // This prevents the client from deleting 102 (which the server never persisted).
  //
  // We compute this by querying the DB for all persisted sequences for this
  // device, then finding the highest N such that all sequences 1..N exist.
  // (Duplicates count as "exists" — the server already has that sequence.)
  const acceptedThroughSequence = await computeContiguousThroughSequence(batch.deviceId);

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
