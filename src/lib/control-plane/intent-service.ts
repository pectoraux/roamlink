/**
 * Control Plane — Intent Lifecycle Service (Phase 9.4 + 9.4.1 Control-Loop Closure)
 *
 * Manages the durable ConnectivityIntent lifecycle with:
 *   - Atomic supersession via db.$transaction (P0-3)
 *   - Idempotency key for offline-safe creation (P1-4)
 *   - Strict expectedVersion equality (P1-5)
 *   - Durable event handoff — no .catch swallow (P1-2)
 *   - INTENT_CHANGED event type (P1-1)
 *
 *   Intent → INTENT_CHANGED event → Reevaluation Worker → makeDecision(intentId, intentVersion, deviceId)
 *
 * NOT: Intent → Action
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { INTENT_TRANSITIONS, type IntentState } from "@/lib/protocol";
import type { ConnectivityIntent } from "@/lib/protocol";

// ---------------------------------------------------------------------------
// Create a new intent (or a new version of an existing intent)
// ---------------------------------------------------------------------------

export type CreateIntentInput = {
  subjectId: string;
  deviceId?: string;
  rawText?: string;
  capabilityType?: string;
  desiredSpec?: Record<string, unknown>;
  location?: Record<string, unknown>;
  maxPriceMinor?: number;
  mode?: "AUTOMATIC" | "MANUAL";
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  expiresAt?: Date;
  source?: "USER" | "AI_PROPOSAL" | "COMMERCIAL" | "SYSTEM";
  supersedesIntentId?: string;
  expectedVersion?: number;
  // Phase 9.4.1: Idempotency key for offline-safe creation
  idempotencyKey?: string;
  // Phase 12.4.4c: Asynchronous causality provenance.
  // The originating request/event ID — lets operators trace from provider log
  // back to "which API request caused this connectivity mutation?"
  // For HTTP: the x-request-id header value.
  // For device events: the event/observation ID.
  // For system jobs: the job/operation ID.
  sourceRequestId?: string;
  // How this intent was initiated: "api" | "device" | "system" | "commercial".
  sourceChannel?: string;
};

export type IntentResult = {
  intentId: string;
  version: number;
  status: IntentState;
  rejected?: string;
  duplicate?: boolean;
};

/**
 * Create a new intent or a new version of an existing intent.
 *
 * P1-4: If idempotencyKey is provided, check for an existing intent with
 * that key and return it (idempotent — mobile retries don't create duplicates).
 */
export async function createIntent(input: CreateIntentInput): Promise<IntentResult> {
  // P1-4: Idempotency check
  if (input.idempotencyKey) {
    const existing = await db.connectivityIntentRecord.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return {
        intentId: existing.intentId,
        version: existing.version,
        status: existing.status as IntentState,
        duplicate: true,
      };
    }
  }

  const payload: ConnectivityIntent = {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    mode: input.mode ?? "MANUAL",
    priority: input.priority ?? "NORMAL",
    source: input.source ?? "USER",
    rawText: input.rawText,
    location: input.location as any,
    capabilityRequirements: input.desiredSpec as any,
    budget: input.maxPriceMinor ? { currency: "USD", maxMinor: input.maxPriceMinor } : undefined,
    confidence: 0,
    version: 1,
    status: "ACTIVE",
  };

  if (input.capabilityType) {
    (payload as any).capabilityType = input.capabilityType;
  }
  if (input.expiresAt) {
    payload.expiresAt = input.expiresAt.toISOString();
  }

  // New intent (no supersession)
  if (!input.supersedesIntentId) {
    const intentId = `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // P0-2 (9.4.2): Transactional durability — intent creation + INTENT_CHANGED
    // event in one transaction. If either fails, neither persists.
    try {
      const result = await db.$transaction(async (tx) => {
        const record = await tx.connectivityIntentRecord.create({
          data: {
            intentId,
            subjectId: input.subjectId,
            deviceId: input.deviceId ?? null,
            version: 1,
            status: "ACTIVE",
            payload: JSON.stringify(payload),
            expiresAt: input.expiresAt ?? null,
            priority: input.priority ?? "NORMAL",
            source: input.source ?? "USER",
            idempotencyKey: input.idempotencyKey ?? null,
            // Phase 12.4.4c: Persist causality provenance.
            sourceRequestId: input.sourceRequestId ?? null,
            sourceChannel: input.sourceChannel ?? null,
          },
        });

        // Emit INTENT_CHANGED within the same transaction
        await tx.reevaluationEvent.create({
          data: {
            type: "INTENT_CHANGED",
            subjectId: input.subjectId,
            resourceId: null,
            sessionId: null,
            payload: JSON.stringify({
              intentId,
              intentVersion: 1,
              subjectId: input.subjectId,
              deviceId: input.deviceId ?? null,
              reason: "intent-created",
            }),
            state: "PENDING",
          },
        });

        return record;
      });

      logger.info("intent.created", { intentId, version: 1, subjectId: input.subjectId });
      return { intentId, version: 1, status: "ACTIVE" };
    } catch (err: any) {
      // P1-3 (9.4.2): Concurrent idempotency — P2002 on unique key
      if (err?.code === "P2002" && input.idempotencyKey) {
        const existing = await db.connectivityIntentRecord.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          return {
            intentId: existing.intentId,
            version: existing.version,
            status: existing.status as IntentState,
            duplicate: true,
          };
        }
      }
      throw err;
    }
  }

  // Supersession: atomic transaction (P0-3)
  return supersedeIntent({
    subjectId: input.subjectId,
    intentId: input.supersedesIntentId,
    expectedVersion: input.expectedVersion,
    payload,
    expiresAt: input.expiresAt,
    priority: input.priority,
    source: input.source,
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Supersede an intent — ATOMIC via db.$transaction (P0-3)
// ---------------------------------------------------------------------------

async function supersedeIntent(input: {
  subjectId: string;
  intentId: string;
  expectedVersion?: number;
  payload: ConnectivityIntent;
  expiresAt?: Date;
  priority?: string;
  source?: string;
  deviceId?: string;
  idempotencyKey?: string;
}): Promise<IntentResult> {
  // P1-4: Idempotency check
  if (input.idempotencyKey) {
    const existing = await db.connectivityIntentRecord.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return {
        intentId: existing.intentId,
        version: existing.version,
        status: existing.status as IntentState,
        duplicate: true,
      };
    }
  }

  try {
    // P0-2 (9.4.2): Atomic transaction — supersede old + create new + emit
    // INTENT_CHANGED event, all in one transaction.
    const result = await db.$transaction(async (tx) => {
      // Find current ACTIVE version within the transaction
      const current = await tx.connectivityIntentRecord.findFirst({
        where: { intentId: input.intentId, status: "ACTIVE" },
        orderBy: { version: "desc" },
      });

      if (!current) {
        return { intentId: input.intentId, version: 0, status: "ACTIVE" as IntentState, rejected: "no-active-intent" };
      }

      // Validate ownership
      if (current.subjectId !== input.subjectId) {
        return { intentId: input.intentId, version: current.version, status: "ACTIVE" as IntentState, rejected: "ownership-violation" };
      }

      // P1-5: Strict expectedVersion equality (not just <)
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        if (input.expectedVersion < current.version) {
          return { intentId: input.intentId, version: current.version, status: "ACTIVE" as IntentState, rejected: "stale-version" };
        } else {
          return { intentId: input.intentId, version: current.version, status: "ACTIVE" as IntentState, rejected: "version-mismatch" };
        }
      }

      if (current.status !== "ACTIVE") {
        return { intentId: input.intentId, version: current.version, status: current.status as IntentState, rejected: "not-active" };
      }

      const newVersion = current.version + 1;

      // Atomically supersede the old version
      const supersedeResult = await tx.connectivityIntentRecord.updateMany({
        where: {
          intentId: input.intentId,
          version: current.version,
          status: "ACTIVE",
        },
        data: {
          status: "SUPERSEDED",
          supersededAt: new Date(),
        },
      });

      if (supersedeResult.count === 0) {
        return { intentId: input.intentId, version: current.version, status: "ACTIVE" as IntentState, rejected: "concurrent-supersession" };
      }

      // Create the new version within the same transaction
      const newRecord = await tx.connectivityIntentRecord.create({
        data: {
          intentId: input.intentId,
          subjectId: input.subjectId,
          deviceId: input.deviceId ?? null,
          version: newVersion,
          status: "ACTIVE",
          supersedesIntentId: input.intentId,
          supersedesVersion: current.version,
          payload: JSON.stringify(input.payload),
          expiresAt: input.expiresAt ?? null,
          priority: input.priority ?? "NORMAL",
          source: input.source ?? "USER",
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      // P0-2: Emit INTENT_CHANGED within the same transaction
      await tx.reevaluationEvent.create({
        data: {
          type: "INTENT_CHANGED",
          subjectId: input.subjectId,
          resourceId: null,
          sessionId: null,
          payload: JSON.stringify({
            intentId: input.intentId,
            intentVersion: newVersion,
            subjectId: input.subjectId,
            deviceId: input.deviceId ?? null,
            reason: "intent-superseded",
          }),
          state: "PENDING",
        },
      });

      return { intentId: input.intentId, version: newVersion, status: "ACTIVE" as IntentState };
    });

    logger.info("intent.superseded", {
      intentId: input.intentId,
      newVersion: result.version,
      subjectId: input.subjectId,
    });

    return result;
  } catch (err) {
    // Transaction failed — no state was mutated
    logger.error("intent.supersede_transaction_failed", {
      intentId: input.intentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { intentId: input.intentId, version: 0, status: "ACTIVE" as IntentState, rejected: "transaction-failed" };
  }
}

// ---------------------------------------------------------------------------
// Get the current active intent for a subject
// ---------------------------------------------------------------------------

export async function getActiveIntent(subjectId: string): Promise<{
  intentId: string;
  version: number;
  status: IntentState;
  payload: ConnectivityIntent;
  expiresAt: Date | null;
  createdAt: Date;
  deviceId: string | null;
} | null> {
  const record = await db.connectivityIntentRecord.findFirst({
    where: { subjectId, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });

  if (!record) return null;

  return {
    intentId: record.intentId,
    version: record.version,
    status: record.status as IntentState,
    payload: JSON.parse(record.payload) as ConnectivityIntent,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    deviceId: record.deviceId,
  };
}

// ---------------------------------------------------------------------------
// Get intent history (all versions)
// ---------------------------------------------------------------------------

export async function getIntentHistory(subjectId: string, intentId?: string): Promise<
  Array<{
    intentId: string;
    version: number;
    status: IntentState;
    supersedesVersion: number | null;
    createdAt: Date;
    supersededAt: Date | null;
  }>
> {
  const records = await db.connectivityIntentRecord.findMany({
    where: {
      subjectId,
      ...(intentId ? { intentId } : {}),
    },
    orderBy: [{ intentId: "asc" }, { version: "desc" }],
    select: {
      intentId: true,
      version: true,
      status: true,
      supersedesVersion: true,
      createdAt: true,
      supersededAt: true,
    },
  });

  return records.map((r) => ({
    intentId: r.intentId,
    version: r.version,
    status: r.status as IntentState,
    supersedesVersion: r.supersedesVersion,
    createdAt: r.createdAt,
    supersededAt: r.supersededAt,
  }));
}

// ---------------------------------------------------------------------------
// Cancel an intent
// ---------------------------------------------------------------------------

export async function cancelIntent(
  subjectId: string,
  intentId: string,
  expectedVersion?: number,
): Promise<IntentResult> {
  // P1-6: Check ownership first — return 403 not 404
  const anyRecord = await db.connectivityIntentRecord.findFirst({
    where: { intentId },
    select: { subjectId: true, version: true, status: true },
    orderBy: { version: "desc" },
  });

  if (!anyRecord) {
    return { intentId, version: 0, status: "ACTIVE", rejected: "not-found" };
  }

  if (anyRecord.subjectId !== subjectId) {
    return { intentId, version: anyRecord.version, status: "ACTIVE" as IntentState, rejected: "ownership-violation" };
  }

  if (anyRecord.status !== "ACTIVE") {
    return { intentId, version: anyRecord.version, status: anyRecord.status as IntentState, rejected: "not-active" };
  }

  // P1-5: Strict expectedVersion equality
  if (expectedVersion !== undefined && expectedVersion !== anyRecord.version) {
    return { intentId, version: anyRecord.version, status: "ACTIVE", rejected: expectedVersion < anyRecord.version ? "stale-version" : "version-mismatch" };
  }

  // P1-4 (9.4.2): Cancellation + INTENT_CHANGED event in ONE transaction.
  // Both the guarded ACTIVE→CANCELLED transition and the event creation
  // happen inside a single db.$transaction. If either fails, neither persists.
  try {
    const txResult = await db.$transaction(async (tx) => {
      // Guarded transition — only succeeds if still ACTIVE at this version
      const cancelResult = await tx.connectivityIntentRecord.updateMany({
        where: { intentId, version: anyRecord.version, status: "ACTIVE" },
        data: { status: "CANCELLED", supersededAt: new Date() },
      });

      if (cancelResult.count === 0) {
        return { cancelled: false, version: anyRecord.version };
      }

      // Create INTENT_CHANGED within the same transaction
      await tx.reevaluationEvent.create({
        data: {
          type: "INTENT_CHANGED",
          subjectId,
          resourceId: null,
          sessionId: null,
          payload: JSON.stringify({
            intentId,
            intentVersion: anyRecord.version,
            subjectId,
            deviceId: null,
            reason: "intent-cancelled",
          }),
          state: "PENDING",
        },
      });

      return { cancelled: true, version: anyRecord.version };
    });

    if (!txResult.cancelled) {
      return { intentId, version: txResult.version, status: "ACTIVE", rejected: "concurrent-modification" };
    }

    logger.info("intent.cancelled", { intentId, version: anyRecord.version, subjectId });
    return { intentId, version: anyRecord.version, status: "CANCELLED" };
  } catch (err) {
    // Transaction failed — intent remains ACTIVE, no event created
    logger.error("intent.cancel_transaction_failed", {
      intentId, version: anyRecord.version, subjectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { intentId, version: anyRecord.version, status: "ACTIVE", rejected: "transaction-failed" };
  }
}

// ---------------------------------------------------------------------------
// Check if an intent is expired (inline — does not depend on cron)
// ---------------------------------------------------------------------------

export async function isIntentExpired(intentId: string, version: number): Promise<boolean> {
  const record = await db.connectivityIntentRecord.findUnique({
    where: { intentId_version: { intentId, version } },
    select: { expiresAt: true, status: true },
  });

  if (!record) return true;
  if (record.status !== "ACTIVE") return true; // superseded/cancelled = not authoritative
  if (!record.expiresAt) return false;
  return record.expiresAt <= new Date();
}

// ---------------------------------------------------------------------------
// Expire stale intents (projection maintenance — not the sole source of truth)
// ---------------------------------------------------------------------------

export async function expireStaleIntents(): Promise<{ expired: number }> {
  const result = await db.connectivityIntentRecord.updateMany({
    where: {
      status: "ACTIVE",
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED", supersededAt: new Date() },
  });

  if (result.count > 0) {
    logger.info("intent.expired_batch", { count: result.count });
  }
  return { expired: result.count };
}

// ---------------------------------------------------------------------------
// Emit INTENT_CHANGED reevaluation signal (P1-1: first-class event type)
// ---------------------------------------------------------------------------

export async function emitIntentReevaluationEvent(
  intentId: string,
  version: number,
  subjectId: string,
  deviceId?: string,
): Promise<void> {
  // P1-1: Use INTENT_CHANGED event type (not MEASUREMENT_RECEIVED)
  await db.reevaluationEvent.create({
    data: {
      type: "INTENT_CHANGED",
      subjectId,
      resourceId: null,
      sessionId: null,
      payload: JSON.stringify({
        intentId,
        intentVersion: version,
        subjectId,
        deviceId: deviceId ?? null,
        reason: "intent-update",
      }),
      state: "PENDING",
    },
  });

  logger.info("intent.reevaluation_emitted", { intentId, version, subjectId, deviceId });
}
