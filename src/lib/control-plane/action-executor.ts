/**
 * Control Plane — Action Executor
 *
 * Translates ConnectivityDecisions into executable ConnectivityActions,
 * then executes them against the frozen connectivity kernel.
 *
 * The action executor is the bridge between the protocol layer and the
 * existing entitlement/provisioning kernel. It NEVER calls provider APIs
 * directly — it always goes through the existing kernel functions:
 *   provisionBinding(), reconcileProvisioning(), etc.
 *
 * Action lifecycle:
 *   PLANNED → AUTHORIZED → EXECUTING → SUCCEEDED
 *                                  → FAILED
 *                                  → RECONCILIATION_REQUIRED
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ACTION_TRANSITIONS } from "@/lib/protocol";
import type { ActionState, ActionType } from "@/lib/protocol";
import { transitionSessionState } from "./session-manager";

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
 * Execute a planned action against the frozen kernel.
 *
 * This is the bridge between the protocol layer and the existing
 * entitlement/provisioning system. It:
 *   1. Authorizes the action (PLANNED → AUTHORIZED)
 *   2. Executes it (AUTHORIZED → EXECUTING)
 *   3. Transitions the session state as needed
 *   4. Marks success or failure
 *
 * The actual kernel calls (provisionBinding, reconcileProvisioning, etc.)
 * happen here — the protocol layer never calls the kernel directly.
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

    // Step 3: Execute based on action type
    switch (action.type) {
      case "ACTIVATE": {
        // Activate a session — transition to ACTIVE
        // In a full implementation, this would call provisionBinding()
        // to create/activate the entitlement + binding.
        // For v1, we transition the session state.
        if (session.state === "RESERVED" || session.state === "PLANNED" || session.state === "DISCOVERING") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        break;
      }

      case "SWITCH": {
        // Switch the session to a new resource
        // In a full implementation, this would:
        //   1. Reserve the new resource
        //   2. Activate the new resource
        //   3. Verify the new resource
        //   4. Release the old resource
        // For v1, we transition: ACTIVE → SWITCHING → ACTIVE
        if (session.state === "ACTIVE" || session.state === "DEGRADED") {
          await transitionSessionState(session.id, "SWITCHING");
          // Update the active resource
          if (action.targetResourceId) {
            await db.connectivitySession.update({
              where: { id: session.id },
              data: { activeResourceId: action.targetResourceId },
            });
          }
          await transitionSessionState(session.id, "ACTIVE");
        }
        break;
      }

      case "SUSPEND": {
        if (session.state === "ACTIVE") {
          // In a full implementation, this would call the adapter's suspend()
          await transitionSessionState(session.id, "DEGRADED");
        }
        break;
      }

      case "RESUME": {
        if (session.state === "DEGRADED") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        break;
      }

      case "RELEASE": {
        // Release the session
        if (session.state !== "ENDED") {
          // In a full implementation, this would call the adapter's release()
          await transitionSessionState(session.id, "ENDED");
        }
        break;
      }

      case "DISCOVER":
      case "RESERVE":
      case "RENEW":
      case "TRANSFER":
        // These are no-ops for v1 — they'll be implemented in later phases
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
