/**
 * Control Plane — Intent Lifecycle Service (Phase 9.4)
 *
 * Manages the durable ConnectivityIntent lifecycle: creation, versioning,
 * supersession, expiry, cancellation. Enforces optimistic concurrency fencing
 * so an offline replay of an older intent version cannot overwrite a newer one.
 *
 *   Intent → ReevaluationEvent → Decision Engine → Decision → Action
 *
 * NOT: Intent → Action
 *
 * The intent is a REQUEST FOR AN OUTCOME. The decision engine translates it.
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
  // For supersession: the intent this one replaces
  supersedesIntentId?: string;
  expectedVersion?: number; // optimistic fencing — the version the caller expects to supersede
};

export type IntentResult = {
  intentId: string;
  version: number;
  status: IntentState;
  rejected?: string;
};

/**
 * Create a new intent or a new version of an existing intent.
 *
 * If `supersedesIntentId` is provided, this creates a new version that
 * supersedes the previous one. The previous version is atomically marked
 * SUPERSEDED.
 *
 * If `expectedVersion` is provided, the server validates that the caller's
 * expected version matches the current version before superseding. A stale
 * request (expectedVersion < currentVersion) is rejected.
 */
export async function createIntent(input: CreateIntentInput): Promise<IntentResult> {
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
    const record = await db.connectivityIntentRecord.create({
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
      },
    });

    logger.info("intent.created", { intentId, version: 1, subjectId: input.subjectId });

    return { intentId, version: 1, status: "ACTIVE" };
  }

  // Supersession: create a new version, atomically supersede the old one
  return supersedeIntent({
    subjectId: input.subjectId,
    intentId: input.supersedesIntentId,
    expectedVersion: input.expectedVersion,
    payload,
    expiresAt: input.expiresAt,
    priority: input.priority,
    source: input.source,
    deviceId: input.deviceId,
  });
}

// ---------------------------------------------------------------------------
// Supersede an intent (atomic version fencing)
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
}): Promise<IntentResult> {
  // Find the current ACTIVE version of this intent
  const current = await db.connectivityIntentRecord.findFirst({
    where: { intentId: input.intentId, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });

  if (!current) {
    return { intentId: input.intentId, version: 0, status: "ACTIVE", rejected: "no-active-intent" };
  }

  // Validate ownership
  if (current.subjectId !== input.subjectId) {
    return { intentId: input.intentId, version: current.version, status: "ACTIVE" as IntentState, rejected: "ownership-violation" };
  }

  // Phase 9.4: Optimistic fencing — reject stale supersession
  if (input.expectedVersion !== undefined && input.expectedVersion < current.version) {
    logger.warn("intent.stale_supersession_rejected", {
      intentId: input.intentId,
      expectedVersion: input.expectedVersion,
      currentVersion: current.version,
    });
    return {
      intentId: input.intentId,
      version: current.version,
      status: "ACTIVE",
      rejected: "stale-version",
    };
  }

  // Also check if the intent is already superseded/expired/cancelled
  if (current.status !== "ACTIVE") {
    return {
      intentId: input.intentId,
      version: current.version,
      status: current.status as IntentState,
      rejected: "not-active",
    };
  }

  const newVersion = current.version + 1;

  // Atomically supersede the old version AND create the new one.
  // The updateMany with WHERE guard ensures only one writer can supersede.
  const supersedeResult = await db.connectivityIntentRecord.updateMany({
    where: {
      intentId: input.intentId,
      version: current.version,
      status: "ACTIVE", // only supersede if still ACTIVE
    },
    data: {
      status: "SUPERSEDED",
      supersededAt: new Date(),
    },
  });

  if (supersedeResult.count === 0) {
    // Another writer beat us — re-read and return current state
    const latest = await db.connectivityIntentRecord.findFirst({
      where: { intentId: input.intentId },
      orderBy: { version: "desc" },
    });
    return {
      intentId: input.intentId,
      version: latest?.version ?? 0,
      status: (latest?.status ?? "ACTIVE") as IntentState,
      rejected: "concurrent-supersession",
    };
  }

  // Create the new version
  const newRecord = await db.connectivityIntentRecord.create({
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
    },
  });

  logger.info("intent.superseded", {
    intentId: input.intentId,
    oldVersion: current.version,
    newVersion,
    subjectId: input.subjectId,
  });

  return { intentId: input.intentId, version: newVersion, status: "ACTIVE" };
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
  const current = await db.connectivityIntentRecord.findFirst({
    where: { intentId, subjectId, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });

  if (!current) {
    return { intentId, version: 0, status: "ACTIVE", rejected: "no-active-intent" };
  }

  // Fencing
  if (expectedVersion !== undefined && expectedVersion < current.version) {
    return { intentId, version: current.version, status: "ACTIVE", rejected: "stale-version" };
  }

  const result = await db.connectivityIntentRecord.updateMany({
    where: { id: current.id, version: current.version, status: "ACTIVE" },
    data: { status: "CANCELLED", supersededAt: new Date() },
  });

  if (result.count === 0) {
    return { intentId, version: current.version, status: "ACTIVE", rejected: "concurrent-modification" };
  }

  logger.info("intent.cancelled", { intentId, version: current.version, subjectId });
  return { intentId, version: current.version, status: "CANCELLED" };
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
// Emit reevaluation signal when intent changes
// ---------------------------------------------------------------------------

export async function emitIntentReevaluationEvent(intentId: string, version: number, subjectId: string): Promise<void> {
  await db.reevaluationEvent.create({
    data: {
      type: "MEASUREMENT_RECEIVED", // reuse existing event type — the worker drains it
      subjectId,
      payload: JSON.stringify({
        intentChanged: true,
        intentId,
        intentVersion: version,
        reason: "intent-update",
      }),
      state: "PENDING",
    },
  }).catch(() => {
    // Non-fatal — the observation worker will also process on its cycle
  });

  logger.info("intent.reevaluation_emitted", { intentId, version, subjectId });
}
