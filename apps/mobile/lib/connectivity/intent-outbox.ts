/**
 * Phase 9.5 (R3-R4) — Mobile Intent Outbox
 *
 * A durable local outbox for intent mutations, mirroring the Phase 9.1
 * observation outbox reliability model.
 *
 * State machine (accurate as of 9.5.1):
 *
 *   PENDING
 *     ↓
 *   CLAIMED (SYNCING) — entry is being transmitted, prevents concurrent flush
 *     ├── success → ACKNOWLEDGED (retained briefly for dedup, then removed)
 *     └── failure → FAILED (retryable on next cycle)
 *
 *   FAILED
 *     ↓ (retry)
 *   CLAIMED
 *
 * The CLAIMED state prevents two concurrent flush invocations from working
 * on the same logical entry.
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
  status: "PENDING" | "CLAIMED" | "ACKNOWLEDGED" | "FAILED";
  // Phase 9.5.2: Lease timestamp for CLAIMED state. If the process dies
  // while CLAIMED, a boot-time reconciliation resets entries whose
  // claimedAt is older than CLAIM_LEASE_MS back to PENDING.
  claimedAt: string | null;
  // Server response (set after successful sync)
  serverIntentId?: string;
  serverVersion?: number;
};

// Phase 9.5.2: CLAIMED lease duration. If an entry has been CLAIMED for
// longer than this, it is considered orphaned (process died mid-sync).
const CLAIM_LEASE_MS = 5 * 60 * 1000; // 5 minutes

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
    claimedAt: null,
  };

  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    outbox.push(entry);
    await saveOutboxUnsafe(outbox);
    return entry.id;
  });
}

/**
 * Load all entries that need processing (PENDING or FAILED).
 * Does NOT return CLAIMED entries (they are being transmitted).
 * Phase 9.5.2: Also reclaims orphaned CLAIMED entries whose lease has expired.
 */
export async function loadPendingIntentOperations(): Promise<IntentOutboxEntry[]> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    const now = Date.now();
    let mutated = false;

    const result = outbox.filter((e) => {
      if (e.status === "PENDING" || e.status === "FAILED") {
        return true;
      }
      if (e.status === "CLAIMED" && e.claimedAt) {
        const claimedMs = new Date(e.claimedAt).getTime();
        if (now - claimedMs > CLAIM_LEASE_MS) {
          // Orphaned claim — reset to PENDING for retry
          e.status = "PENDING";
          e.claimedAt = null;
          mutated = true;
          return true;
        }
      }
      return false;
    });

    if (mutated) {
      await saveOutboxUnsafe(outbox);
    }

    return result;
  });
}

/**
 * Claim an entry for transmission (PENDING/FAILED → CLAIMED).
 * Sets claimedAt for lease expiry tracking.
 * Returns true if the claim succeeded, false if already claimed.
 */
export async function claimIntentOperation(entryId: string): Promise<boolean> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    const entry = outbox.find((e) => e.id === entryId);
    if (!entry) return false;
    if (entry.status === "CLAIMED") {
      // Check lease expiry — if the lease has expired, reclaim
      if (entry.claimedAt) {
        const claimedMs = new Date(entry.claimedAt).getTime();
        if (Date.now() - claimedMs > CLAIM_LEASE_MS) {
          entry.claimedAt = new Date().toISOString();
          entry.attemptCount++;
          entry.lastAttemptAt = new Date().toISOString();
          await saveOutboxUnsafe(outbox);
          return true;
        }
      }
      return false; // still within lease
    }
    entry.status = "CLAIMED";
    entry.claimedAt = new Date().toISOString();
    entry.attemptCount++;
    entry.lastAttemptAt = new Date().toISOString();
    await saveOutboxUnsafe(outbox);
    return true;
  });
}

/**
 * Acknowledge an entry (CLAIMED → ACKNOWLEDGED, then removed).
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
 * Fail an entry (CLAIMED → FAILED, retryable on next cycle).
 */
export async function failIntentOperation(entryId: string): Promise<void> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    const entry = outbox.find((e) => e.id === entryId);
    if (entry) {
      entry.status = "FAILED";
      await saveOutboxUnsafe(outbox);
    }
  });
}

/**
 * Get the current outbox size (for UI/debug).
 */
export async function getIntentOutboxSize(): Promise<number> {
  return serialized(async () => {
    const outbox = await loadOutboxUnsafe();
    return outbox.filter((e) => e.status === "PENDING" || e.status === "FAILED").length;
  });
}

/**
 * Clear the entire intent outbox (for testing/reset).
 */
export async function clearIntentOutbox(): Promise<void> {
  return serialized(() => AsyncStorage.removeItem(INTENT_OUTBOX_KEY));
}
