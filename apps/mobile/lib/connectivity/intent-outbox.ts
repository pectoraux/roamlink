/**
 * Phase 9.5 (R3-R4) — Mobile Intent Outbox
 *
 * A durable local outbox for intent mutations, mirroring the Phase 9.1
 * observation outbox reliability model.
 *
 *   local intent mutation
 *       ↓
 *   durable outbox (AsyncStorage)
 *       ↓
 *   idempotency key
 *       ↓
 *   server ACK / current version
 *       ↓
 *   safe removal
 *
 * The mobile becomes an intent CLIENT, not a decision client.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const INTENT_OUTBOX_KEY = "roamlink_intent_outbox";

// ---------------------------------------------------------------------------
// Intent outbox entry
// ---------------------------------------------------------------------------

export type IntentOperation =
  | { type: "CREATE"; payload: CreateIntentPayload; idempotencyKey: string }
  | { type: "SUPERSEDE"; intentId: string; expectedVersion: number; payload: CreateIntentPayload; idempotencyKey: string }
  | { type: "CANCEL"; intentId: string; expectedVersion: number; idempotencyKey: string };

export type CreateIntentPayload = {
  rawText?: string;
  capabilityType?: string;
  desiredSpec?: Record<string, unknown>;
  location?: Record<string, unknown>;
  maxPriceMinor?: number;
  mode?: "AUTOMATIC" | "MANUAL";
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  expiresAt?: string;
  deviceId?: string;
};

export type IntentOutboxEntry = {
  id: string;
  operation: IntentOperation;
  createdAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  status: "PENDING" | "SYNCING" | "ACKNOWLEDGED" | "FAILED";
  // Server response (set after successful sync)
  serverIntentId?: string;
  serverVersion?: number;
};

// ---------------------------------------------------------------------------
// Serialized mutations (same pattern as observation outbox)
// ---------------------------------------------------------------------------

let mutexChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutexChain.then(fn, fn);
  mutexChain = result.catch(() => {});
  return result;
}

async function loadOutboxUnsafe(): Promise<IntentOutboxEntry[]> {
  const raw = await AsyncStorage.getItem(INTENT_OUTBOX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as IntentOutboxEntry[];
  } catch {
    return [];
  }
}

async function saveOutboxUnsafe(outbox: IntentOutboxEntry[]): Promise<void> {
  await AsyncStorage.setItem(INTENT_OUTBOX_KEY, JSON.stringify(outbox));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue an intent operation. Returns the local entry ID.
 * The operation will be synced when flushIntentOutbox() is called.
 */
export async function enqueueIntentOperation(operation: IntentOperation): Promise<string> {
  const entry: IntentOutboxEntry = {
    id: `intent-op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    operation,
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    lastAttemptAt: null,
    status: "PENDING",
  };

  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    outbox.push(entry);
    await saveOutboxUnsafe(outbox);
    return entry.id;
  });
}

/**
 * Load all pending (non-acknowledged) intent operations.
 */
export async function loadPendingIntentOperations(): Promise<IntentOutboxEntry[]> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    return outbox.filter((e) => e.status === "PENDING" || e.status === "FAILED");
  });
}

/**
 * Mark an outbox entry as acknowledged (server accepted it).
 * The entry is removed after acknowledgment.
 */
export async function acknowledgeIntentOperation(entryId: string, serverIntentId: string, serverVersion: number): Promise<void> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    const filtered = outbox.filter((e) => e.id !== entryId);
    await saveOutboxUnsafe(filtered);
  });
}

/**
 * Mark an outbox entry as failed (will retry on next sync cycle).
 */
export async function failIntentOperation(entryId: string): Promise<void> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    const entry = outbox.find((e) => e.id === entryId);
    if (entry) {
      entry.status = "FAILED";
      entry.attemptCount++;
      entry.lastAttemptAt = new Date().toISOString();
      await saveOutboxUnsafe(outbox);
    }
  });
}

/**
 * Get the current outbox size (for UI/debug).
 */
export async function getIntentOutboxSize(): Promise<number> {
  const outbox = await loadPendingIntentOperations();
  return outbox.length;
}

/**
 * Clear the entire intent outbox (for testing/reset).
 */
export async function clearIntentOutbox(): Promise<void> {
  return serialized(() => AsyncStorage.removeItem(INTENT_OUTBOX_KEY));
}
