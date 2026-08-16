/**
 * Control Plane — Re-evaluation Triggers (Phase 8.6.4)
 *
 * Event-driven decision re-evaluation. Replaces blind polling: the system
 * reacts to trustworthy events rather than re-evaluating every session on a
 * timer. This is the foundation that will let the mobile agent remain
 * lightweight.
 *
 * Events:
 *   MEASUREMENT_RECEIVED    — a new measurement was ingested
 *   RESOURCE_DEGRADED       — a resource crossed into DEGRADED health
 *   RESOURCE_RECOVERED      — a DEGRADED resource returned to HEALTHY
 *   QUOTA_THRESHOLD_REACHED — data quota crossed a threshold
 *   PROVIDER_UNAVAILABLE    — a provider instance went unavailable
 *   LOCATION_CHANGED        — the subject's location changed
 *   POLICY_CHANGED          — the subject's policy was updated
 *
 * Flow:
 *   event → isReevaluationNecessary? → decision engine → action executor
 *
 * Events are persisted (ReevaluationEvent) so a worker can process them
 * durably. The ingestion layer processes them inline (synchronous path).
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { makeDecision } from "./decision-engine";
import { createAction, executeAction } from "./action-executor";

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
};

// ---------------------------------------------------------------------------
// Resolve the active session affected by a resource event
// ---------------------------------------------------------------------------

/**
 * Find the ACTIVE/DEGRADED/SWITCHING session whose activeResourceId matches
 * the given resource. This is the session a resource event would affect.
 */
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

// ---------------------------------------------------------------------------
// Resolve tenantId for a session (from its active resource's capability)
// ---------------------------------------------------------------------------

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

async function resolveTenantForResource(resourceId: string): Promise<string | null> {
  const resource = await db.protocolResource.findUnique({
    where: { id: resourceId },
    select: { capability: { select: { tenantId: true, type: true } } },
  });
  return resource?.capability?.tenantId ?? null;
}

// ---------------------------------------------------------------------------
// Is re-evaluation necessary for this event?
// ---------------------------------------------------------------------------

/**
 * Whether a re-evaluation event warrants a new decision.
 *
 * A re-evaluation is necessary when the event affects an ACTIVE (or DEGRADED/
 * SWITCHING) session. Events on idle resources (no active session) are marked
 * processed with result "skipped:no-active-session".
 */
export async function isReevaluationNecessary(event: ReevaluationEventRow): Promise<{
  necessary: boolean;
  sessionId?: string;
  reason: string;
}> {
  // Explicit session linkage
  if (event.sessionId) {
    const session = await db.connectivitySession.findUnique({
      where: { id: event.sessionId },
      select: { id: true, state: true, subjectId: true },
    });
    if (!session) {
      return { necessary: false, reason: "skipped:session-not-found" };
    }
    if (!["ACTIVE", "DEGRADED", "SWITCHING"].includes(session.state)) {
      return { necessary: false, sessionId: session.id, reason: `skipped:session-state-${session.state}` };
    }
    return { necessary: true, sessionId: session.id, reason: "session-active" };
  }

  // Resource-linked event: find the active session that owns the resource
  if (event.resourceId) {
    const session = await findSessionForResource(event.resourceId);
    if (!session) {
      return { necessary: false, reason: "skipped:no-active-session" };
    }
    return { necessary: true, sessionId: session.id, reason: "resource-has-active-session" };
  }

  // Subject-linked event (e.g. POLICY_CHANGED, LOCATION_CHANGED)
  if (event.subjectId) {
    const session = await db.connectivitySession.findFirst({
      where: {
        subjectId: event.subjectId,
        state: { in: ["ACTIVE", "DEGRADED", "SWITCHING"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!session) {
      return { necessary: false, reason: "skipped:no-active-session" };
    }
    return { necessary: true, sessionId: session.id, reason: "subject-has-active-session" };
  }

  return { necessary: false, reason: "skipped:no-target" };
}

// ---------------------------------------------------------------------------
// Trigger a re-evaluation for a session
// ---------------------------------------------------------------------------

export type ReevaluationResult = {
  sessionId: string;
  decisionAction: string;
  actionExecuted: boolean;
  actionId?: string;
  actionStatus?: string;
  error?: string;
};

/**
 * Re-evaluate a session: run the decision engine and, if it produces a
 * non-KEEP/non-WAIT action, create + execute the action.
 *
 * The decision engine consults the persisted ResourceHealth snapshot and
 * enforces freshness gating, so this is safe to call on every relevant event.
 */
export async function triggerReevaluation(sessionId: string): Promise<ReevaluationResult> {
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { id: true, subjectId: true, state: true, intentId: true, activeResourceId: true },
  });

  if (!session) {
    return { sessionId, decisionAction: "NONE", actionExecuted: false, error: "session-not-found" };
  }

  const tenantId = await resolveTenantForSession(sessionId);
  if (!tenantId) {
    return { sessionId, decisionAction: "NONE", actionExecuted: false, error: "no-tenant-for-session" };
  }

  // Resolve the capability type from the active resource (for discovery)
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

  if (decision.action === "KEEP" || decision.action === "WAIT" || decision.action === "ASK_USER") {
    logger.info("reevaluation.keep", {
      sessionId, action: decision.action, reasons: decision.reasons,
    });
    return { sessionId, decisionAction: decision.action, actionExecuted: false };
  }

  // Non-KEEP action: create + execute
  const action = await createAction({
    sessionId: session.id,
    decisionId: decision.decisionId,
    type: decision.action as "ACTIVATE" | "SWITCH" | "RESERVE" | "RENEW" | "RELEASE",
    targetResourceId: decision.targetResourceId,
    reason: decision.reasons.join("; ") || undefined,
    idempotencyKey: `reeval-${session.id}-${decision.action}-${Date.now()}`,
  });

  const execResult = await executeAction(action.id);

  logger.info("reevaluation.executed", {
    sessionId,
    action: decision.action,
    actionId: action.id,
    status: execResult.status,
  });

  return {
    sessionId,
    decisionAction: decision.action,
    actionExecuted: true,
    actionId: action.id,
    actionStatus: execResult.status,
    error: execResult.error,
  };
}

// ---------------------------------------------------------------------------
// Process pending events
// ---------------------------------------------------------------------------

/**
 * Process all unprocessed re-evaluation events for a specific resource.
 * Called synchronously by the ingestion layer.
 */
export async function processPendingEventsForResource(resourceId: string): Promise<number> {
  const events = await db.reevaluationEvent.findMany({
    where: { resourceId, processedAt: null },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  let processed = 0;
  for (const event of events) {
    await processEvent(event);
    processed++;
  }
  return processed;
}

/**
 * Process a single re-evaluation event.
 */
export async function processEvent(event: ReevaluationEventRow): Promise<{ result: string }> {
  const necessity = await isReevaluationNecessary(event);

  if (!necessity.necessary) {
    await db.reevaluationEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), result: necessity.reason },
    });
    return { result: necessity.reason };
  }

  const sessionId = necessity.sessionId!;
  let result = `reevaluated:skip`;
  try {
    const reeval = await triggerReevaluation(sessionId);
    result = `reevaluated:${reeval.decisionAction}:${reeval.actionExecuted ? "executed" : "noop"}`;
  } catch (err) {
    result = `error:${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`;
    logger.error("reevaluation.event_error", { eventId: event.id, sessionId, error: result });
  }

  await db.reevaluationEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date(), result },
  });

  return { result };
}

/**
 * Process all unprocessed re-evaluation events (worker entry point).
 */
export async function processPendingEvents(limit = 50): Promise<{ processed: number; results: Record<string, number> }> {
  const events = await db.reevaluationEvent.findMany({
    where: { processedAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const results: Record<string, number> = {};
  let processed = 0;
  for (const event of events) {
    const { result } = await processEvent(event);
    results[result] = (results[result] ?? 0) + 1;
    processed++;
  }
  return { processed, results };
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
}): Promise<{ eventId: string }> {
  const event = await db.reevaluationEvent.create({
    data: {
      type: input.type,
      resourceId: input.resourceId ?? null,
      sessionId: input.sessionId ?? null,
      subjectId: input.subjectId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
    },
  });
  return { eventId: event.id };
}
