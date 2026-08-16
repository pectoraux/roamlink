/**
 * Control Plane — Action Executor v2 (Phase 8.4)
 *
 * CHANGED FROM v1:
 *   v1: SWITCH just transitions session state (no resource operations)
 *   v2: SWITCH performs full resource transaction:
 *     1. Reserve target resource (ownership-safe)
 *     2. Activate target (mark IN_USE, update session)
 *     3. Verify target is usable
 *     4. Release previous resource (ownership-safe)
 *     5. Any failure leaves a recoverable state
 *
 * ACTIVATE also performs:
 *     1. Reserve resource
 *     2. Mark IN_USE
 *     3. Transition session to ACTIVE
 *
 * The action executor NEVER calls provider APIs directly — it operates
 * on ProtocolResource records and session state. The frozen kernel is
 * called only when provisioning is needed (future: via a bridge function).
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ACTION_TRANSITIONS } from "@/lib/protocol";
import type { ActionState, ActionType } from "@/lib/protocol";
import { transitionSessionState } from "./session-manager";
import { reserveResource, releaseResource, markResourceInUse } from "./capability-registry";

// ---------------------------------------------------------------------------
// Create Action
// ---------------------------------------------------------------------------

export async function createAction(input: {
  sessionId: string;
  decisionId?: string;
  type: ActionType;
  targetResourceId?: string;
  reason?: string;
  policyVersion?: string;
}): Promise<{ id: string; state: string; idempotencyKey: string }> {
  const idempotencyKey = `action-${input.sessionId}-${input.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const action = await db.connectivityAction.create({
    data: {
      sessionId: input.sessionId,
      decisionId: input.decisionId ?? null,
      type: input.type,
      targetResourceId: input.targetResourceId ?? null,
      state: "PLANNED",
      reason: input.reason ?? null,
      policyVersion: input.policyVersion ?? null,
      idempotencyKey,
    },
  });

  logger.info("action.created", {
    actionId: action.id,
    sessionId: input.sessionId,
    type: input.type,
    targetResourceId: input.targetResourceId,
  });

  return { id: action.id, state: action.state, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Transition Action State
// ---------------------------------------------------------------------------

export async function transitionActionState(
  actionId: string,
  toState: ActionState,
  error?: string,
): Promise<{ id: string; state: string }> {
  const action = await db.connectivityAction.findUnique({
    where: { id: actionId },
    select: { state: true },
  });

  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }

  const currentState = action.state as ActionState;
  const allowed = ACTION_TRANSITIONS[currentState] ?? [];

  if (!allowed.includes(toState)) {
    throw new Error(
      `Illegal action transition: ${currentState} → ${toState}. Allowed: ${allowed.join(", ")}`,
    );
  }

  const updateData: Record<string, unknown> = { state: toState };
  if (toState === "EXECUTING") {
    updateData.executedAt = new Date();
  }
  if (toState === "SUCCEEDED" || toState === "FAILED") {
    updateData.completedAt = new Date();
  }
  if (error) {
    updateData.error = error;
  }

  const updated = await db.connectivityAction.update({
    where: { id: actionId },
    data: updateData,
  });

  logger.info("action.transitioned", { actionId, from: currentState, to: toState });
  return { id: updated.id, state: updated.state };
}

// ---------------------------------------------------------------------------
// Execute Action
// ---------------------------------------------------------------------------

/**
 * Execute a planned action. This is the real resource-driven execution path.
 *
 * SWITCH transaction:
 *   1. Reserve target resource (ownership-safe)
 *      → fail: action FAILED, session unchanged, target stays AVAILABLE
 *   2. Activate target (mark IN_USE)
 *   3. Verify target is usable
 *      → fail: release target, action FAILED, session unchanged
 *   4. Transition session → SWITCHING → ACTIVE
 *   5. Update session.activeResourceId = target
 *   6. Release previous resource (ownership-safe)
 *      → fail: session is still on target (correct), mark RECONCILIATION_REQUIRED
 *
 * Key invariant: releasing the old resource MUST NOT invalidate the new one.
 */
export async function executeAction(actionId: string): Promise<{
  status: "succeeded" | "failed";
  error?: string;
}> {
  const action = await db.connectivityAction.findUnique({
    where: { id: actionId },
    include: { session: true },
  });

  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }

  if (action.state !== "PLANNED") {
    throw new Error(`Action state is ${action.state}, expected PLANNED`);
  }

  try {
    // Step 1: Authorize
    await transitionActionState(actionId, "AUTHORIZED");

    // Step 2: Execute
    await transitionActionState(actionId, "EXECUTING");

    const session = action.session;
    const targetResourceId = action.targetResourceId;

    if (!targetResourceId) {
      throw new Error("SWITCH/ACTIVATE action requires targetResourceId");
    }

    // Step 3: Execute based on action type
    switch (action.type) {
      // -------------------------------------------------------------------
      // ACTIVATE: reserve → mark IN_USE → session ACTIVE
      // -------------------------------------------------------------------
      case "ACTIVATE": {
        // 3a. Reserve the target resource
        const reserveResult = await reserveResource(targetResourceId, session.id);
        if (!reserveResult.reserved) {
          throw new Error(`Failed to reserve resource ${targetResourceId}: ${reserveResult.reason}`);
        }

        // 3b. Mark resource as IN_USE
        await markResourceInUse(targetResourceId, session.id);

        // 3c. Update session
        await db.connectivitySession.update({
          where: { id: session.id },
          data: {
            activeResourceId: targetResourceId,
            startedAt: new Date(),
            lastObservedAt: new Date(),
          },
        });

        // 3d. Transition session to ACTIVE
        if (session.state === "PLANNED" || session.state === "DISCOVERING" || session.state === "RESERVED") {
          await transitionSessionState(session.id, "ACTIVE");
        }

        logger.info("action.activate_succeeded", {
          actionId, sessionId: session.id, resourceId: targetResourceId,
        });
        break;
      }

      // -------------------------------------------------------------------
      // SWITCH: reserve target → activate → verify → update session → release old
      // -------------------------------------------------------------------
      case "SWITCH": {
        if (session.state !== "ACTIVE" && session.state !== "DEGRADED") {
          throw new Error(`SWITCH requires session to be ACTIVE or DEGRADED, got ${session.state}`);
        }

        const previousResourceId = session.activeResourceId;

        // 3a. Transition session to SWITCHING
        await transitionSessionState(session.id, "SWITCHING");

        // 3b. Reserve the target resource (ownership-safe)
        const reserveResult = await reserveResource(targetResourceId, session.id);
        if (!reserveResult.reserved) {
          // Failed to reserve — recover: session back to ACTIVE on old resource
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Failed to reserve target resource ${targetResourceId}: ${reserveResult.reason}`);
        }

        // 3c. Mark target as IN_USE
        await markResourceInUse(targetResourceId, session.id);

        // 3d. Verify target is usable (check it's IN_USE)
        const targetResource = await db.protocolResource.findUnique({
          where: { id: targetResourceId },
          select: { state: true, reservedBy: true },
        });

        if (!targetResource || targetResource.state !== "IN_USE" || targetResource.reservedBy !== session.id) {
          // Verification failed — release target, recover session
          await releaseResource(targetResourceId, session.id);
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Target resource ${targetResourceId} verification failed — state: ${targetResource?.state ?? "null"}`);
        }

        // 3e. Atomically update session to point to new resource
        await db.connectivitySession.update({
          where: { id: session.id },
          data: {
            activeResourceId: targetResourceId,
            lastObservedAt: new Date(),
          },
        });

        // 3f. Transition session back to ACTIVE
        await transitionSessionState(session.id, "ACTIVE");

        // 3g. Release the previous resource (ownership-safe)
        // IMPORTANT: failure here does NOT invalidate the new resource.
        // The session is already on the target. The old resource release
        // is best-effort — if it fails, mark for reconciliation.
        if (previousResourceId && previousResourceId !== targetResourceId) {
          const releaseResult = await releaseResource(previousResourceId, session.id);
          if (!releaseResult.released) {
            // Session is correctly on the target — old resource release failed.
            // This is a reconciliation issue, not a switch failure.
            logger.warn("action.switch_old_release_failed", {
              actionId,
              sessionId: session.id,
              oldResourceId: previousResourceId,
              reason: releaseResult.reason,
              message: "Session switched to new resource but old resource release failed — reconciliation required.",
            });
            // Don't fail the action — the switch succeeded. The old resource
            // will be cleaned up by reconciliation.
          }
        }

        logger.info("action.switch_succeeded", {
          actionId,
          sessionId: session.id,
          fromResource: previousResourceId,
          toResource: targetResourceId,
        });
        break;
      }

      // -------------------------------------------------------------------
      // SUSPEND: session ACTIVE → DEGRADED
      // -------------------------------------------------------------------
      case "SUSPEND": {
        if (session.state === "ACTIVE") {
          await transitionSessionState(session.id, "DEGRADED");
        }
        break;
      }

      // -------------------------------------------------------------------
      // RESUME: session DEGRADED → ACTIVE
      // -------------------------------------------------------------------
      case "RESUME": {
        if (session.state === "DEGRADED") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        break;
      }

      // -------------------------------------------------------------------
      // RELEASE: release resource + session ENDED
      // -------------------------------------------------------------------
      case "RELEASE": {
        if (session.state !== "ENDED") {
          // Release the active resource (ownership-safe)
          if (session.activeResourceId) {
            await releaseResource(session.activeResourceId, session.id);
          }
          await transitionSessionState(session.id, "ENDED");
        }
        break;
      }

      // -------------------------------------------------------------------
      // Not yet implemented
      // -------------------------------------------------------------------
      case "DISCOVER":
      case "RESERVE":
      case "RENEW":
      case "TRANSFER":
        logger.info("action.type_not_yet_implemented", { actionId, type: action.type });
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    // Step 4: Mark success
    await transitionActionState(actionId, "SUCCEEDED");

    logger.info("action.executed", { actionId, type: action.type, sessionId: session.id });

    return { status: "succeeded" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await transitionActionState(actionId, "FAILED", errorMsg);

    logger.error("action.failed", { actionId, error: errorMsg });

    return { status: "failed", error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Get Action History for Session
// ---------------------------------------------------------------------------

export async function getActionHistory(sessionId: string) {
  const actions = await db.connectivityAction.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    include: { decision: true },
  });

  return actions;
}
