/**
 * Phase 9.1 — Observation Outbox
 *
 * A durable local outbox for observations. Observations are persisted locally
 * before upload, so the UI never blocks on telemetry and observations survive
 * network failures.
 *
 * Flow:
 *   device observation
 *       ↓
 *   local outbox (AsyncStorage)
 *       ↓
 *   network available?
 *       ├── no → retain
 *       └── yes
 *            ↓
 *       batch upload
 *            ↓
 *       ack
 *            ↓
 *       delete acknowledged observations
 *
 * Bounded storage: when limits are reached, preferentially discard OLD
 * low-value observations, never the newest.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EdgeObservation } from "@roamlink/shared";

const OUTBOX_KEY = "roamlink_obs_outbox";
const MAX_OBSERVATIONS = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_BATCH_SIZE = 50;

/**
 * Add an observation to the outbox.
 */
export async function enqueueObservation(obs: EdgeObservation): Promise<void> {
  const outbox = await loadOutbox();
  outbox.push(obs);

  // Enforce bounds: if over limit, drop the OLDEST observations (never the newest)
  if (outbox.length > MAX_OBSERVATIONS) {
    const overflow = outbox.length - MAX_OBSERVATIONS;
    outbox.splice(0, overflow);
  }

  // Drop observations older than MAX_AGE (low-value, stale)
  const cutoff = Date.now() - MAX_AGE_MS;
  const filtered = outbox.filter((o) => new Date(o.observedAt).getTime() > cutoff);

  await saveOutbox(filtered);
}

/**
 * Load all pending observations from the outbox.
 */
export async function loadOutbox(): Promise<EdgeObservation[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as EdgeObservation[];
  } catch {
    return [];
  }
}

/**
 * Get the next batch to upload (up to MAX_BATCH_SIZE, oldest first).
 */
export async function getPendingBatch(deviceId: string): Promise<EdgeObservation[]> {
  const outbox = await loadOutbox();
  return outbox
    .filter((o) => o.deviceId === deviceId)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, MAX_BATCH_SIZE);
}

/**
 * Remove acknowledged observations from the outbox (after a successful upload).
 * Uses observationId to match — duplicates that were collapsed server-side
 * are also removed.
 */
export async function removeAcknowledged(acknowledgedIds: string[]): Promise<void> {
  if (acknowledgedIds.length === 0) return;
  const outbox = await loadOutbox();
  const ackSet = new Set(acknowledgedIds);
  const remaining = outbox.filter((o) => !ackSet.has(o.observationId));
  await saveOutbox(remaining);
}

/**
 * Get the current outbox size (for UI/debug).
 */
export async function getOutboxSize(): Promise<number> {
  const outbox = await loadOutbox();
  return outbox.length;
}

/**
 * Clear the entire outbox (for testing/reset).
 */
export async function clearOutbox(): Promise<void> {
  await AsyncStorage.removeItem(OUTBOX_KEY);
}

// Internal helpers

async function saveOutbox(outbox: EdgeObservation[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
}
