/**
 * Phase 9.1 — Sync
 *
 * Drains the outbox: uploads pending observations to the control plane in
 * batches, removes acknowledged ones, retains unacknowledged ones.
 *
 * Never blocks the UI — the caller (a background timer or app-state hook)
 * invokes flushOutbox() periodically.
 */

import { api, getSession, API_BASE_URL } from "../api";
import { getDeviceId, getDeviceContext } from "./device-context";
import { enqueueObservation, getPendingBatch, removeAcknowledged, loadOutbox } from "./outbox";
import { recordObservation } from "./observation";
import type { EdgeObservation, EdgeObservationAck } from "@roamlink/shared";

/**
 * Register the device with the control plane (idempotent — call on app start).
 */
export async function ensureDeviceRegistered(): Promise<void> {
  const token = await getSession();
  if (!token) return;

  const [deviceId, context] = await Promise.all([getDeviceId(), getDeviceContext()]);
  try {
    await api.registerEdgeDevice(token, {
      deviceId,
      platform: context.platform,
      appVersion: context.appVersion,
    });
  } catch (err) {
    // Non-fatal — will retry on next sync
    console.warn("[edge] device registration failed:", err);
  }
}

/**
 * Record an observation and enqueue it for upload.
 */
export async function recordAndEnqueue(input?: { sessionId?: string; resourceId?: string }): Promise<EdgeObservation> {
  const obs = await recordObservation(input);
  await enqueueObservation(obs);
  return obs;
}

/**
 * Flush the outbox: upload pending observations, remove acknowledged ones.
 * Returns the ack (or null if nothing to upload / not authenticated).
 */
export async function flushOutbox(): Promise<EdgeObservationAck | null> {
  const token = await getSession();
  if (!token) return null;

  const deviceId = await getDeviceId();
  const pending = await getPendingBatch(deviceId);
  if (pending.length === 0) return null;

  try {
    const ack = await api.uploadEdgeObservations(token, { deviceId, observations: pending });

    // Remove acknowledged observations. The ack gives us acceptedThroughSequence
    // — all observations with sequence <= that are accepted (including duplicates).
    const ackedIds = pending
      .filter((o) => o.sequence <= ack.acceptedThroughSequence)
      .map((o) => o.observationId);
    await removeAcknowledged(ackedIds);

    // Also remove any observations that were rejected (don't retry poison)
    if (ack.rejected.length > 0) {
      const rejectedIds = ack.rejected.map((r) => r.observationId);
      await removeAcknowledged(rejectedIds);
    }

    return ack;
  } catch (err) {
    // Upload failed — observations remain in the outbox for next flush.
    console.warn("[edge] outbox flush failed:", err);
    return null;
  }
}

/**
 * Get the current outbox size (for UI display).
 */
export async function getPendingCount(): Promise<number> {
  return loadOutbox().then((o) => o.length);
}

// ---------------------------------------------------------------------------
// Observation lifecycle (start/stop)
// ---------------------------------------------------------------------------

let observationTimer: ReturnType<typeof setInterval> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

const OBSERVATION_INTERVAL_MS = 30_000; // observe every 30s
const SYNC_INTERVAL_MS = 60_000; // sync every 60s

/**
 * Start periodic observation + sync. Called on app focus / login.
 */
export function startObservation(sessionId?: string, resourceId?: string): void {
  stopObservation();

  // Initial registration + flush
  ensureDeviceRegistered().then(() => flushOutbox());

  // Periodic observation
  observationTimer = setInterval(async () => {
    await recordAndEnqueue({ sessionId, resourceId });
  }, OBSERVATION_INTERVAL_MS);

  // Periodic sync
  syncTimer = setInterval(async () => {
    await flushOutbox();
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop periodic observation + sync. Called on app background / logout.
 * Flushes any pending observations before stopping.
 */
export function stopObservation(): void {
  if (observationTimer) {
    clearInterval(observationTimer);
    observationTimer = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  // Final flush
  flushOutbox().catch(() => {});
}
