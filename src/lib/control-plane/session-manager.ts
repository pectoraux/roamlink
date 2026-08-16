/**
 * Control Plane — Session Manager
 *
 * Manages the lifecycle of ConnectivitySession objects. A session represents
 * what connectivity is currently serving a user. It sits above the frozen
 * entitlement kernel (which manages the commercial right to consume) and
 * below the decision engine (which decides what to do).
 *
 * State machine:
 *   PLANNED → DISCOVERING → RESERVED → ACTIVE → DEGRADED → SWITCHING → ACTIVE
 *                                                                    → ENDED
 *                                                                    → FAILED
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { SESSION_TRANSITIONS } from "@/lib/protocol";
import type { ConnectivitySessionState } from "@/lib/protocol";

// ---------------------------------------------------------------------------
// Create Session
// ---------------------------------------------------------------------------

export async function createSession(input: {
  subjectId: string;
  intentId?: string;
  entitlementId?: string;
  policyId?: string;
}): Promise<{ id: string; state: string }> {
  const session = await db.connectivitySession.create({
    data: {
      subjectId: input.subjectId,
      intentId: input.intentId ?? null,
      entitlementId: input.entitlementId ?? null,
      policyId: input.policyId ?? null,
      state: "PLANNED",
    },
  });

  logger.info("session.created", { sessionId: session.id, subjectId: input.subjectId });
  return { id: session.id, state: session.state };
}

// ---------------------------------------------------------------------------
// Transition Session State
// ---------------------------------------------------------------------------

export async function transitionSessionState(
  sessionId: string,
  toState: ConnectivitySessionState,
): Promise<{ id: string; state: string }> {
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { state: true },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const currentState = session.state as ConnectivitySessionState;
  const allowed = SESSION_TRANSITIONS[currentState] ?? [];

  if (!allowed.includes(toState)) {
    throw new Error(
      `Illegal session transition: ${currentState} → ${toState}. Allowed: ${allowed.join(", ")}`,
    );
  }

  const updateData: Record<string, unknown> = { state: toState };
  if (toState === "ACTIVE" && !session.state.match(/ACTIVE|DEGRADED|SWITCHING/)) {
    updateData.startedAt = new Date();
  }
  if (toState === "ENDED") {
    updateData.endedAt = new Date();
  }
  updateData.lastObservedAt = new Date();

  const updated = await db.connectivitySession.update({
    where: { id: sessionId },
    data: updateData,
  });

  logger.info("session.transitioned", { sessionId, from: currentState, to: toState });
  return { id: updated.id, state: updated.state };
}

// ---------------------------------------------------------------------------
// Get Session
// ---------------------------------------------------------------------------

export async function getSession(sessionId: string) {
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    include: {
      measurements: { orderBy: { capturedAt: "desc" }, take: 10 },
      decisions: { orderBy: { createdAt: "desc" }, take: 5 },
      actions: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  return session;
}

// ---------------------------------------------------------------------------
// Get Active Session for Subject
// ---------------------------------------------------------------------------

export async function getActiveSessionForSubject(subjectId: string) {
  const session = await db.connectivitySession.findFirst({
    where: {
      subjectId,
      state: { in: ["ACTIVE", "DEGRADED", "SWITCHING", "RESERVED"] },
    },
    orderBy: { createdAt: "desc" },
  });

  return session;
}

// ---------------------------------------------------------------------------
// Record Measurement
// ---------------------------------------------------------------------------

export async function recordMeasurement(input: {
  sessionId?: string;
  resourceId?: string;
  providerInstanceId?: string;
  type: "USAGE" | "QUALITY" | "AVAILABILITY";
  metrics: Record<string, unknown>;
  freshness?: string;
  source?: string;
  confidence?: number;
}): Promise<{ id: string }> {
  const measurement = await db.connectivityMeasurement.create({
    data: {
      sessionId: input.sessionId ?? null,
      resourceId: input.resourceId ?? null,
      providerInstanceId: input.providerInstanceId ?? null,
      type: input.type,
      metrics: JSON.stringify(input.metrics),
      freshness: input.freshness ?? "UNKNOWN",
      source: input.source ?? "system",
      confidence: input.confidence ?? 0.5,
    },
  });

  // Update session's lastObservedAt
  if (input.sessionId) {
    await db.connectivitySession.update({
      where: { id: input.sessionId },
      data: { lastObservedAt: new Date() },
    }).catch(() => {});
  }

  logger.info("measurement.recorded", {
    measurementId: measurement.id,
    sessionId: input.sessionId,
    type: input.type,
  });

  return { id: measurement.id };
}
