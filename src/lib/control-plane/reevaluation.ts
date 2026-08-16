/**
 * Control Plane — Re-evaluation Triggers (Phase 8.6.4 + 8.6.5)
 *
 * Event-driven decision re-evaluation with durable worker semantics. Replaces
 * blind polling: the system reacts to trustworthy events rather than
 * re-evaluating every session on a timer.
 *
 * Phase 8.6.5 hardening:
 *   - Events have a lifecycle (PENDING → CLAIMED → COMPLETED/FAILED/DEAD_LETTER)
 *     with claim tokens + lease expiry — the SAME fencing pattern as
 *     ConnectivityAction recovery. The observation loop is a distributed worker
 *     system and is fenced accordingly.
 *   - Decision triggering is SEPARATED from decision execution. This worker
 *     produces a ConnectivityDecision (PENDING) and does NOT invoke the adapter
 *     or mutate the session. A separate decision-executor turns non-KEEP
 *     decisions into ConnectivityActions.
 *   - Duplicate events are deduped by idempotencyKey (two probes of the same
 *     observation → one decision).
 *
 * Events:
 *   MEASUREMENT_RECEIVED, RESOURCE_DEGRADED, RESOURCE_RECOVERED,
 *   QUOTA_THRESHOLD_REACHED, PROVIDER_UNAVAILABLE, LOCATION_CHANGED,
 *   POLICY_CHANGED
 *
 * Flow:
 *   event (PENDING) → claim (CLAIMED) → evaluate → Decision (PENDING)
 *       → COMPLETED.  [decision-executor then executes non-KEEP decisions]
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { makeDecision } from "./decision-engine";

// ---------------------------------------------------------------------------
// Lifecycle constants (Phase 8.6.5)
// ---------------------------------------------------------------------------

export const EVENT_STATE_PENDING = "PENDING" as const;
export const EVENT_STATE_CLAIMED = "CLAIMED" as const;
export const EVENT_STATE_PROCESSING = "PROCESSING" as const;
export const EVENT_STATE_COMPLETED = "COMPLETED" as const;
export const EVENT_STATE_FAILED = "FAILED" as const;
export const EVENT_STATE_DEAD_LETTER = "DEAD_LETTER" as const;

/** Lease duration for a claimed event. A crashed worker's claim expires after this. */
export const EVENT_LEASE_MS = 60_000; // 60 seconds — evaluation is fast
/** Max attempts before an event is dead-lettered (poison-event protection). */
export const EVENT_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReevaluationEventRow = {
  id: string;
  type: string;
  resourceId: string | null;
  sessionId: string | null;
  subjectId: string | null;
  payload: string;
  state: string;
  claimId: string | null;
  attemptCount: number;
};

// ---------------------------------------------------------------------------
// Resolve the active session affected by a resource event
// ---------------------------------------------------------------------------

async function findSessionForResource(resourceId: string): Promise<{ id: string; subjectId: string; state: string } | null> {
  const session = await db.connectivitySession.findFirst({
    where: {
      activeResourceId: resourceId,
      state: { in: ["ACTIVE", "DEGRADED", "SWITCHING"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, subjectId: true, state: true },
  });
  return session ?? null;
}

async function resolveTenantForSession(sessionId: string): Promise<string | null> {
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { activeResourceId: true },
  });
  if (!session?.activeResourceId) return null;
  const resource = await db.protocolResource.findUnique({
    where: { id: session.activeResourceId },
    select: { capability: { select: { tenantId: true } } },
  });
  return resource?.capability?.tenantId ?? null;
}

// ---------------------------------------------------------------------------
// Is re-evaluation necessary for this event?
// ---------------------------------------------------------------------------

export async function isReevaluationNecessary(event: ReevaluationEventRow): Promise<{
  necessary: boolean;
  sessionId?: string;
  reason: string;
}> {
  if (event.sessionId) {
    const session = await db.connectivitySession.findUnique({
      where: { id: event.sessionId },
      select: { id: true, state: true, subjectId: true },
    });
    if (!session) return { necessary: false, reason: "skipped:session-not-found" };
    if (!["ACTIVE", "DEGRADED", "SWITCHING"].includes(session.state)) {
      return { necessary: false, sessionId: session.id, reason: `skipped:session-state-${session.state}` };
    }
    return { necessary: true, sessionId: session.id, reason: "session-active" };
  }

  if (event.resourceId) {
    const session = await findSessionForResource(event.resourceId);
    if (!session) return { necessary: false, reason: "skipped:no-active-session" };
    return { necessary: true, sessionId: session.id, reason: "resource-has-active-session" };
  }

  if (event.subjectId) {
    const session = await db.connectivitySession.findFirst({
      where: { subjectId: event.subjectId, state: { in: ["ACTIVE", "DEGRADED", "SWITCHING"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!session) return { necessary: false, reason: "skipped:no-active-session" };
    return { necessary: true, sessionId: session.id, reason: "subject-has-active-session" };
  }

  return { necessary: false, reason: "skipped:no-target" };
}

// ---------------------------------------------------------------------------
// Phase 8.6.5: Fenced event claim
// ---------------------------------------------------------------------------

/**
 * Atomically claim a pending (or expired-claim) re-evaluation event for a
 * worker. Returns the claimed event, or null if none were available.
 *
 * An event is claimable if:
 *   - state = PENDING, OR
 *   - state = CLAIMED AND claimExpiresAt < now (the previous worker died)
 *
 * The claim is atomic (updateMany with a WHERE guard) so two concurrent
 * workers cannot both claim the same event. The claim token (claimId) fences
 * the event: only the worker holding it may complete/fail the event.
 */
export async function claimReevaluationEvent(
  workerId: string,
  filter?: { resourceId?: string; subjectId?: string; sessionId?: string },
): Promise<ReevaluationEventRow | null> {
  const now = new Date();
  const claimId = `claim-${workerId}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const claimExpiresAt = new Date(now.getTime() + EVENT_LEASE_MS);

  // Atomically claim the oldest pending or expired-claim event.
  // An optional filter scopes the claim to a specific resource/subject/session.
  const claimableWhere = {
    OR: [
      { state: EVENT_STATE_PENDING },
      { state: EVENT_STATE_CLAIMED, claimExpiresAt: { lt: now } },
      { state: EVENT_STATE_FAILED, claimExpiresAt: { lt: now } },
    ],
    ...(filter?.resourceId ? { resourceId: filter.resourceId } : {}),
    ...(filter?.subjectId ? { subjectId: filter.subjectId } : {}),
    ...(filter?.sessionId ? { sessionId: filter.sessionId } : {}),
  };

  const claimed = await db.reevaluationEvent.findFirst({
    where: claimableWhere,
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  if (!claimed) return null;

  // Fenced update: only transition if the event is still in a claimable state.
  // This prevents a race where two workers both selected the same row.
  const result = await db.reevaluationEvent.updateMany({
    where: {
      id: claimed.id,
      OR: [
        { state: EVENT_STATE_PENDING },
        { state: EVENT_STATE_CLAIMED, claimExpiresAt: { lt: now } },
        { state: EVENT_STATE_FAILED, claimExpiresAt: { lt: now } },
      ],
    },
    data: {
      state: EVENT_STATE_CLAIMED,
      claimId,
      claimedAt: now,
      claimExpiresAt,
      attemptCount: { increment: 1 },
    },
  });

  if (result.count === 0) {
    // Another worker beat us to it — recurse to try the next one.
    return claimReevaluationEvent(workerId, filter);
  }

  logger.info("reevaluation.event_claimed", {
    eventId: claimed.id, claimId, attemptCount: claimed.attemptCount + 1,
  });

  return {
    id: claimed.id,
    type: claimed.type,
    resourceId: claimed.resourceId,
    sessionId: claimed.sessionId,
    subjectId: claimed.subjectId,
    payload: claimed.payload,
    state: EVENT_STATE_CLAIMED,
    claimId,
    attemptCount: claimed.attemptCount + 1,
  };
}

// ---------------------------------------------------------------------------
// Phase 8.6.5: Evaluate an event → produce a ConnectivityDecision
// (does NOT execute — that's the decision-executor's job)
// ---------------------------------------------------------------------------

export type EvaluationResult = {
  eventId: string;
  decisionId?: string;
  decisionAction: string;
  result: string;
};

/**
 * Evaluate a claimed event: run the decision engine and persist a
 * ConnectivityDecision (executionState = PENDING for non-KEEP, SKIPPED for
 * KEEP/WAIT/ASK_USER).
 *
 * This does NOT create or execute a ConnectivityAction. Decision execution is
 * the responsibility of the decision-executor, keeping triggering (read-only:
 * decide what to do) separate from execution (mutate session/adapter).
 */
export async function evaluateEvent(event: ReevaluationEventRow): Promise<EvaluationResult> {
  const necessity = await isReevaluationNecessary(event);

  if (!necessity.necessary) {
    return {
      eventId: event.id,
      decisionAction: "NONE",
      result: necessity.reason,
    };
  }

  const sessionId = necessity.sessionId!;
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { id: true, subjectId: true, state: true, intentId: true, activeResourceId: true },
  });

  if (!session) {
    return { eventId: event.id, decisionAction: "NONE", result: "skipped:session-not-found" };
  }

  const tenantId = await resolveTenantForSession(sessionId);
  if (!tenantId) {
    return { eventId: event.id, decisionAction: "NONE", result: "skipped:no-tenant" };
  }

  let capabilityType: string | undefined;
  if (session.activeResourceId) {
    const resource = await db.protocolResource.findUnique({
      where: { id: session.activeResourceId },
      select: { capability: { select: { type: true } } },
    });
    capabilityType = resource?.capability?.type ?? undefined;
  }

  const decision = await makeDecision({
    tenantId,
    subjectId: session.subjectId,
    intentId: session.intentId ?? undefined,
    sessionId: session.id,
    capabilityType,
  });

  // Mark KEEP/WAIT/ASK_USER as SKIPPED (no action needed). Non-KEEP stays
  // PENDING for the decision-executor to pick up.
  const isTerminal = ["KEEP", "WAIT", "ASK_USER"].includes(decision.action);
  await db.connectivityDecision.update({
    where: { id: decision.decisionId },
    data: {
      executionState: isTerminal ? "SKIPPED" : "PENDING",
      executedAt: isTerminal ? new Date() : null,
    },
  });

  logger.info("reevaluation.evaluated", {
    eventId: event.id, sessionId, action: decision.action, executionState: isTerminal ? "SKIPPED" : "PENDING",
  });

  return {
    eventId: event.id,
    decisionId: decision.decisionId,
    decisionAction: decision.action,
    result: `evaluated:${decision.action}:${isTerminal ? "skipped" : "pending-execution"}`,
  };
}

// ---------------------------------------------------------------------------
// Phase 8.6.5: Complete / fail an event (fenced by claimId)
// ---------------------------------------------------------------------------

async function completeEvent(eventId: string, claimId: string, result: string): Promise<boolean> {
  const res = await db.reevaluationEvent.updateMany({
    where: { id: eventId, claimId }, // fenced — only the claiming worker completes
    data: {
      state: EVENT_STATE_COMPLETED,
      processedAt: new Date(),
      result,
      lastError: null,
    },
  });
  return res.count > 0;
}

async function failEvent(eventId: string, claimId: string, error: string, attemptCount: number): Promise<{ deadLettered: boolean }> {
  // Dead-letter after too many attempts — poison-event protection.
  if (attemptCount >= EVENT_MAX_ATTEMPTS) {
    await db.reevaluationEvent.updateMany({
      where: { id: eventId, claimId },
      data: {
        state: EVENT_STATE_DEAD_LETTER,
        processedAt: new Date(),
        result: `dead-lettered:attempt-${attemptCount}`,
        lastError: error,
      },
    });
    logger.error("reevaluation.event_dead_lettered", { eventId, attemptCount, error });
    return { deadLettered: true };
  }

  // Return to FAILED (claimable after lease expiry) for retry.
  await db.reevaluationEvent.updateMany({
    where: { id: eventId, claimId },
    data: {
      state: EVENT_STATE_FAILED,
      lastError: error,
      // Keep claimExpiresAt so it isn't immediately reclaimable (backoff).
      claimExpiresAt: new Date(Date.now() + EVENT_LEASE_MS),
    },
  });
  logger.warn("reevaluation.event_failed", { eventId, attemptCount, error });
  return { deadLettered: false };
}

// ---------------------------------------------------------------------------
// Process a claimed event (claim → evaluate → complete/fail)
// ---------------------------------------------------------------------------

/**
 * Process a single claimed event: evaluate it, then mark COMPLETED or FAILED.
 * The claim must have been acquired via claimReevaluationEvent().
 */
export async function processClaimedEvent(event: ReevaluationEventRow, claimId: string): Promise<{ result: string; deadLettered: boolean }> {
  let result: string;
  let deadLettered = false;
  try {
    const evalResult = await evaluateEvent(event);
    result = evalResult.result;
    await completeEvent(event.id, claimId, result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    result = `error:${errorMsg}`;
    const failRes = await failEvent(event.id, claimId, errorMsg, event.attemptCount);
    deadLettered = failRes.deadLettered;
  }
  return { result, deadLettered };
}

// ---------------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------------

/**
 * Claim and process a single event (one worker iteration). Returns null if no
 * event was available.
 */
export async function processOneEvent(workerId: string): Promise<{ result: string; deadLettered: boolean; eventId: string } | null> {
  const event = await claimReevaluationEvent(workerId);
  if (!event) return null;

  // The claimId was set on the row by claimReevaluationEvent; re-read it.
  const row = await db.reevaluationEvent.findUnique({ where: { id: event.id }, select: { claimId: true } });
  const claimId = row?.claimId;
  if (!claimId) {
    // Lost the claim somehow — mark failed for retry.
    await failEvent(event.id, "", "claim-lost", event.attemptCount);
    return { result: "error:claim-lost", deadLettered: false, eventId: event.id };
  }

  const { result, deadLettered } = await processClaimedEvent(event, claimId);
  return { result, deadLettered, eventId: event.id };
}

/**
 * Process pending re-evaluation events for a specific resource (synchronous
 * path used by the ingestion layer).
 */
export async function processPendingEventsForResource(resourceId: string): Promise<number> {
  let processed = 0;
  const workerId = `ingest-${resourceId.slice(0, 8)}`;
  for (let i = 0; i < 20; i++) {
    // Claim only events for this resource (scoped claim via filter).
    const event = await claimReevaluationEvent(workerId, { resourceId });
    if (!event) break;
    const row = await db.reevaluationEvent.findUnique({ where: { id: event.id }, select: { claimId: true } });
    if (row?.claimId) {
      await processClaimedEvent(event, row.claimId);
    }
    processed++;
  }
  return processed;
}

/**
 * Process all pending re-evaluation events (worker entry point). Claims +
 * evaluates events, leaving non-KEEP decisions PENDING for the decision-executor.
 */
export async function processPendingEvents(limit = 50, workerId = `worker-${Date.now()}`): Promise<{ processed: number; results: Record<string, number> }> {
  const results: Record<string, number> = {};
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const res = await processOneEvent(workerId);
    if (!res) break;
    results[res.result] = (results[res.result] ?? 0) + 1;
    processed++;
  }
  return { processed, results };
}

// ---------------------------------------------------------------------------
// Reclaim expired claims (cron cleanup — abandoned worker recovery)
// ---------------------------------------------------------------------------

/**
 * Reclaim events whose claims have expired (the worker died mid-evaluation).
 * Returns them to PENDING so another worker can pick them up. Dead-letters
 * events that have exceeded the max attempt count.
 */
export async function reclaimExpiredClaims(): Promise<{ reclaimed: number; deadLettered: number }> {
  const now = new Date();
  // Find claimed/failed events with expired leases.
  const expired = await db.reevaluationEvent.findMany({
    where: {
      state: { in: [EVENT_STATE_CLAIMED, EVENT_STATE_FAILED] },
      claimExpiresAt: { lt: now },
    },
    select: { id: true, attemptCount: true },
    take: 100,
  });

  let reclaimed = 0;
  let deadLettered = 0;
  for (const event of expired) {
    if (event.attemptCount >= EVENT_MAX_ATTEMPTS) {
      await db.reevaluationEvent.update({
        where: { id: event.id },
        data: { state: EVENT_STATE_DEAD_LETTER, processedAt: now, result: "dead-lettered:max-attempts" },
      }).catch(() => {});
      deadLettered++;
    } else {
      await db.reevaluationEvent.update({
        where: { id: event.id },
        data: { state: EVENT_STATE_PENDING, claimId: null, claimedAt: null },
      }).catch(() => {});
      reclaimed++;
    }
  }

  if (reclaimed > 0 || deadLettered > 0) {
    logger.info("reevaluation.reclaimed", { reclaimed, deadLettered });
  }
  return { reclaimed, deadLettered };
}

// ---------------------------------------------------------------------------
// Manual event emission (for non-measurement triggers)
// ---------------------------------------------------------------------------

export async function emitReevaluationEvent(input: {
  type: "QUOTA_THRESHOLD_REACHED" | "PROVIDER_UNAVAILABLE" | "LOCATION_CHANGED" | "POLICY_CHANGED";
  resourceId?: string;
  sessionId?: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ eventId: string; duplicate: boolean }> {
  // Idempotent: if idempotencyKey supplied and exists, return existing.
  if (input.idempotencyKey) {
    const existing = await db.reevaluationEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { eventId: existing.id, duplicate: true };
  }

  try {
    const event = await db.reevaluationEvent.create({
      data: {
        type: input.type,
        resourceId: input.resourceId ?? null,
        sessionId: input.sessionId ?? null,
        subjectId: input.subjectId ?? null,
        payload: JSON.stringify(input.payload ?? {}),
        idempotencyKey: input.idempotencyKey ?? null,
        state: EVENT_STATE_PENDING,
      },
    });
    return { eventId: event.id, duplicate: false };
  } catch (err: any) {
    if (err?.code === "P2002" && input.idempotencyKey) {
      const existing = await db.reevaluationEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) return { eventId: existing.id, duplicate: true };
    }
    throw err;
  }
}
