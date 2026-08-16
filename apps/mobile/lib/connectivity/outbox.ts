/**
 * Phase 9.1.1 — Serialized Outbox Actor
 *
 * A single serialized queue for all outbox mutations (enqueue, remove, flush).
 * Prevents the read-modify-write race where concurrent producers overwrite
 * each other's observations.
 *
 *   record observation ─┐
 *   record observation ─┼→ outbox mutex → load → mutate → save
 *   flush              ─┘
 *
 * All outbox mutations go through this single queue. The queue is
 * per-process (mobile apps are single-process).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EdgeObservation } from "@roamlink/shared";

const OUTBOX_KEY = "roamlink_obs_outbox";
const MAX_OBSERVATIONS = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Serialized mutation queue (Phase 9.1.1)
// ---------------------------------------------------------------------------

/**
 * A simple promise-chain mutex. Each mutation waits for the previous one to
 * complete before running. This serializes load → mutate → save so concurrent
 * operations don't overwrite each other.
 */
let mutexChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutexChain.then(fn, fn);
  // Swallow rejections in the chain so one failure doesn't block subsequent ops.
  mutexChain = result.catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Internal load/save (only called under the mutex)
// ---------------------------------------------------------------------------

async function loadOutboxUnsafe(): Promise<EdgeObservation[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as EdgeObservation[];
  } catch {
    return [];
  }
}

async function saveOutboxUnsafe(outbox: EdgeObservation[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
}

// ---------------------------------------------------------------------------
// Public API (all serialized)
// ---------------------------------------------------------------------------

/**
 * Add an observation to the outbox. Serialized so concurrent enqueues don't
 * overwrite each other.
 */
export async function enqueueObservation(obs: EdgeObservation): Promise<void> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    outbox.push(obs);

    // Enforce bounds: if over limit, drop the OLDEST observations (never the newest)
    if (outbox.length > MAX_OBSERVATIONS) {
      const overflow = outbox.length - MAX_OBSERVATIONS;
      outbox.splice(0, overflow);
    }

    // Drop observations older than MAX_AGE (low-value, stale)
    const cutoff = Date.now() - MAX_AGE_MS;
    const filtered = outbox.filter((o) => new Date(o.observedAt).getTime() > cutoff);

    await saveOutboxUnsafe(filtered);
  });
}

/**
 * Load all pending observations from the outbox. Read-only (no mutation), but
 * serialized to ensure a consistent snapshot (no partial writes visible).
 */
export async function loadOutbox(): Promise<EdgeObservation[]> {
  return serialized(() => loadOutboxUnsafe());
}

/**
 * Get the next batch to upload (up to MAX_BATCH_SIZE, oldest first).
 */
export async function getPendingBatch(deviceId: string): Promise<EdgeObservation[]> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    return outbox
      .filter((o) => o.deviceId === deviceId)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, MAX_BATCH_SIZE);
  });
}

/**
 * Remove acknowledged observations from the outbox (after a successful upload).
 * Serialized so a concurrent enqueue can't be lost during the remove.
 */
export async function removeAcknowledged(acknowledgedIds: string[]): Promise<void> {
  if (acknowledgedIds.length === 0) return;
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    const ackSet = new Set(acknowledgedIds);
    const remaining = outbox.filter((o) => !ackSet.has(o.observationId));
    await saveOutboxUnsafe(remaining);
  });
}

/**
 * Atomically allocate the next sequence number AND enqueue the observation.
 * This prevents the race where two concurrent observations read the same
 * sequence number.
 *
 * Phase 9.1.1: sequence allocation + outbox write happen under one mutex.
 */
export async function allocateSequenceAndEnqueue(
  deviceId: string,
  buildObservation: (sequence: number) => EdgeObservation,
): Promise<EdgeObservation> {
  return serialized(async () => {
    // Read current sequence
    const seqStr = await AsyncStorage.getItem("roamlink_obs_sequence");
    const currentSeq = seqStr ? parseInt(seqStr, 10) : 0;
    const nextSeq = currentSeq + 1;

    // Write the new sequence
    await AsyncStorage.setItem("roamlink_obs_sequence", String(nextSeq));

    // Build + enqueue the observation under the same mutex
    const obs = buildObservation(nextSeq);
    const outbox = await loadOutboxUnsafe();
    outbox.push(obs);

    if (outbox.length > MAX_OBSERVATIONS) {
      const overflow = outbox.length - MAX_OBSERVATIONS;
      outbox.splice(0, overflow);
    }

    const cutoff = Date.now() - MAX_AGE_MS;
    const filtered = outbox.filter((o) => new Date(o.observedAt).getTime() > cutoff);

    await saveOutboxUnsafe(filtered);

    return obs;
  });
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
  return serialized(() => AsyncStorage.removeItem(OUTBOX_KEY));
}
