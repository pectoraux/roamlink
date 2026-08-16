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
import { resolveResourceBinding, verifyResourceUsable } from "./kernel-bridge";

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
  idempotencyKey?: string; // caller-supplied durable key (Phase 8.5.3)
}): Promise<{ id: string; state: string; idempotencyKey: string }> {
  // Phase 8.5.3: accept caller-supplied idempotency key for durable retry.
  // If not supplied, generate one (backward compat).
  const idempotencyKey = input.idempotencyKey ?? `action-${input.sessionId}-${input.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Phase 8.5.3: idempotent create — if an action with this key already exists,
  // return it instead of creating a duplicate.
  // Phase 8.5.7: Handle concurrent race — if findUnique returns null but create
  // throws a unique constraint violation, re-read the existing action.
  const existing = await db.connectivityAction.findUnique({
    where: { idempotencyKey },
  });

  if (existing) {
    logger.info("action.idempotent_return", {
      actionId: existing.id,
      idempotencyKey,
      state: existing.state,
    });
    return { id: existing.id, state: existing.state, idempotencyKey };
  }

  let action;
  try {
    action = await db.connectivityAction.create({
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
  } catch (err: any) {
    // Phase 8.5.7: Handle unique constraint violation from concurrent create
    if (err?.code === "P2002") {
      // Unique constraint on idempotencyKey — another worker created it first.
      // Re-read and return the existing action.
      const concurrent = await db.connectivityAction.findUnique({
        where: { idempotencyKey },
      });
      if (concurrent) {
        logger.info("action.concurrent_idempotent_return", {
          actionId: concurrent.id,
          idempotencyKey,
          state: concurrent.state,
        });
        return { id: concurrent.id, state: concurrent.state, idempotencyKey };
      }
    }
    throw err;
  }

  logger.info("action.created", {
    actionId: action.id,
    sessionId: input.sessionId,
    type: input.type,
    targetResourceId: input.targetResourceId,
    idempotencyKey,
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

        // 3b. Resolve resource binding via kernel bridge
        // Phase 8.5.8: tenantId is DERIVED from the resource's capability, not caller-supplied
        const bridgeResult = await resolveResourceBinding({
          protocolResourceId: targetResourceId,
          subjectId: session.subjectId,
        });

        if (bridgeResult.status === "failed") {
          await releaseResource(targetResourceId, session.id);
          throw new Error(`Kernel bridge failed: ${bridgeResult.error}`);
        }
        if (bridgeResult.status === "reconciliation_required") {
          await releaseResource(targetResourceId, session.id);
          throw new Error(`Kernel bridge requires reconciliation: ${bridgeResult.error}`);
        }

        // 3c. Mark resource as IN_USE — fail closed
        const activateResult = await markResourceInUse(targetResourceId, session.id);
        if (!activateResult.activated) {
          await releaseResource(targetResourceId, session.id);
          throw new Error(`Failed to mark resource IN_USE: ${activateResult.reason}`);
        }

        // 3d. Verify via kernel bridge (USABLE | NOT_USABLE | UNKNOWN)
        const verifyResult = await verifyResourceUsable(targetResourceId, session.id);
        if (verifyResult.status === "NOT_USABLE") {
          await releaseResource(targetResourceId, session.id);
          throw new Error(`Resource verification failed: ${verifyResult.reason}`);
        }

        // Phase 8.5.9: UNKNOWN → release target, do NOT activate session, RECONCILIATION_REQUIRED
        if (verifyResult.status === "UNKNOWN") {
          await releaseResource(targetResourceId, session.id);
          await transitionActionState(actionId, "RECONCILIATION_REQUIRED", `Verification UNKNOWN: ${verifyResult.reason}`);
          logger.warn("action.activate_unknown_verification", {
            actionId, targetResourceId, reason: verifyResult.reason,
          });
          return { status: "failed", error: `Verification UNKNOWN — target released, reconciliation required: ${verifyResult.reason}` };
        }

        // 3e. Update session with entitlement link (only if USABLE)
        await db.connectivitySession.update({
          where: { id: session.id },
          data: {
            activeResourceId: targetResourceId,
            entitlementId: bridgeResult.entitlementId,
            startedAt: new Date(),
            lastObservedAt: new Date(),
          },
        });

        // 3f. Transition session to ACTIVE
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
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Failed to reserve target resource ${targetResourceId}: ${reserveResult.reason}`);
        }

        // 3c. Resolve target binding via kernel bridge
        // Phase 8.5.8: tenantId derived from resource, not caller-supplied
        const bridgeResult = await resolveResourceBinding({
          protocolResourceId: targetResourceId,
          subjectId: session.subjectId,
        });

        if (bridgeResult.status === "failed") {
          await releaseResource(targetResourceId, session.id);
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Kernel bridge failed for target: ${bridgeResult.error}`);
        }
        if (bridgeResult.status === "reconciliation_required") {
          await releaseResource(targetResourceId, session.id);
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Kernel bridge requires reconciliation for target: ${bridgeResult.error}`);
        }

        // 3d. Mark target as IN_USE — fail closed
        const activateResult = await markResourceInUse(targetResourceId, session.id);
        if (!activateResult.activated) {
          await releaseResource(targetResourceId, session.id);
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Failed to mark target IN_USE: ${activateResult.reason}`);
        }

        // 3e. Verify target is usable (USABLE | NOT_USABLE | UNKNOWN)
        const verifyResult = await verifyResourceUsable(targetResourceId, session.id);
        if (verifyResult.status === "NOT_USABLE") {
          await releaseResource(targetResourceId, session.id);
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          throw new Error(`Target verification failed: ${verifyResult.reason}`);
        }
        if (verifyResult.status === "UNKNOWN") {
          // Phase 8.5.8: UNKNOWN → RECONCILIATION_REQUIRED (NOT SUCCEEDED)
          // The session stays on the old resource — we don't switch to an unverified target.
          await releaseResource(targetResourceId, session.id);
          await transitionSessionState(session.id, session.state === "DEGRADED" ? "DEGRADED" : "ACTIVE");
          await transitionActionState(actionId, "RECONCILIATION_REQUIRED", `Switch verification UNKNOWN: ${verifyResult.reason}`);
          logger.warn("action.switch_verification_unknown", {
            actionId, targetResourceId, reason: verifyResult.reason,
          });
          return { status: "failed", error: `Switch verification UNKNOWN — reconciliation required: ${verifyResult.reason}` };
        }

        // 3f. Atomically update session to point to new resource + entitlement
        await db.connectivitySession.update({
          where: { id: session.id },
          data: {
            activeResourceId: targetResourceId,
            entitlementId: bridgeResult.entitlementId,
            lastObservedAt: new Date(),
          },
        });

        // 3g. Transition session back to ACTIVE
        await transitionSessionState(session.id, "ACTIVE");

        // 3g. Release the previous resource (ownership-safe)
        // IMPORTANT: failure here does NOT invalidate the new resource.
        // Phase 8.5.8: Persist a durable reconciliation marker on failure.
        let oldReleaseFailed = false;
        if (previousResourceId && previousResourceId !== targetResourceId) {
          const releaseResult = await releaseResource(previousResourceId, session.id);
          if (!releaseResult.released) {
            oldReleaseFailed = true;
            logger.warn("action.switch_old_release_failed", {
              actionId,
              sessionId: session.id,
              oldResourceId: previousResourceId,
              reason: releaseResult.reason,
            });
          }
        }

        logger.info("action.switch_succeeded", {
          actionId,
          sessionId: session.id,
          fromResource: previousResourceId,
          toResource: targetResourceId,
          oldReleaseFailed,
        });

        // Phase 8.5.8: If old resource release failed, mark RECONCILIATION_REQUIRED
        // instead of SUCCEEDED. The switch itself succeeded (session is on target),
        // but the old resource is leaked and needs cleanup.
        if (oldReleaseFailed) {
          await transitionActionState(actionId, "RECONCILIATION_REQUIRED", `Old resource ${previousResourceId} release failed — session is on target but cleanup needed`);
          return { status: "succeeded", error: `Switch succeeded but old resource release failed — reconciliation required` };
        }
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

// ---------------------------------------------------------------------------
// Phase 8.5.3: Durable Action Recovery Worker
// ---------------------------------------------------------------------------

/**
 * Recover EXECUTING actions that were interrupted by a crash.
 *
 * An action in EXECUTING state means the process died mid-execution.
 * The recovery worker inspects the session + resource state and converges:
 *
 *   - If the target resource is IN_USE and owned by the session → SUCCEEDED
 *   - If the target resource is RESERVED but not IN_USE → release + FAILED
 *   - If the target resource is AVAILABLE (never reserved) → FAILED
 *   - If the session is SWITCHING and target is IN_USE → complete the switch
 *   - Otherwise → RECONCILIATION_REQUIRED
 *
 * This is the control-plane equivalent of the kernel's reconcileProvisioning().
 */
export async function recoverStaleActions(): Promise<{
  recovered: number;
  succeeded: number;
  failed: number;
  reconciliationRequired: number;
}> {
  // Phase 8.5.9: Real recovery-worker fencing with claim token.
  // 1. Generate a unique claim ID for this worker invocation
  // 2. Atomically transition EXECUTING → RECOVERY_CLAIMED with the claim ID
  // 3. Query ONLY actions claimed by THIS worker (recoveryClaimId = claimId)
  // This prevents two workers from processing the same action.
  const claimId = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const claimResult = await db.connectivityAction.updateMany({
    where: { state: "EXECUTING" },
    data: {
      state: "RECOVERY_CLAIMED",
      recoveryClaimId: claimId,
      recoveryClaimedAt: new Date(),
    },
  });

  if (claimResult.count === 0) {
    return { recovered: 0, succeeded: 0, failed: 0, reconciliationRequired: 0 };
  }

  // Query ONLY the actions claimed by this worker
  const staleActions = await db.connectivityAction.findMany({
    where: { recoveryClaimId: claimId },
    include: { session: true },
  });

  let succeeded = 0;
  let failed = 0;
  let reconciliationRequired = 0;

  for (const action of staleActions) {
    const session = action.session;
    const targetResourceId = action.targetResourceId;

    if (!targetResourceId) {
      await transitionActionState(action.id, "FAILED", "No targetResourceId on EXECUTING action");
      failed++;
      continue;
    }

    // Check the target resource state
    const resource = await db.protocolResource.findUnique({
      where: { id: targetResourceId },
      select: { state: true, reservedBy: true, providerBindingId: true },
    });

    if (!resource) {
      await transitionActionState(action.id, "FAILED", "Target resource not found during recovery");
      failed++;
      continue;
    }

    if (resource.state === "IN_USE" && resource.reservedBy === session.id) {
      // Phase 8.5.9: Use the kernel bridge to validate binding ownership
      // (same authority as normal execution, not a weaker manual lookup)
      const bridgeResult = await resolveResourceBinding({
        protocolResourceId: targetResourceId,
        subjectId: session.subjectId,
      });

      if (bridgeResult.status === "failed") {
        await releaseResource(targetResourceId, session.id);
        if (session.state === "SWITCHING") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        await transitionActionState(action.id, "FAILED", `Recovery binding validation failed: ${bridgeResult.error}`);
        failed++;
        continue;
      }

      if (bridgeResult.status === "reconciliation_required") {
        if (session.state === "SWITCHING") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        await transitionActionState(action.id, "RECONCILIATION_REQUIRED", `Recovery binding reconciliation: ${bridgeResult.error}`);
        reconciliationRequired++;
        continue;
      }

      // Bridge validated — now verify provider truth
      const verifyResult = await verifyResourceUsable(targetResourceId, session.id);

      if (verifyResult.status === "NOT_USABLE") {
        await releaseResource(targetResourceId, session.id);
        if (session.state === "SWITCHING") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        await transitionActionState(action.id, "FAILED", `Recovery verification NOT_USABLE: ${verifyResult.reason}`);
        failed++;
        continue;
      }

      if (verifyResult.status === "UNKNOWN") {
        if (session.state === "SWITCHING") {
          await transitionSessionState(session.id, "ACTIVE");
        }
        await transitionActionState(action.id, "RECONCILIATION_REQUIRED", `Recovery verification UNKNOWN: ${verifyResult.reason}`);
        reconciliationRequired++;
        continue;
      }

      // USABLE — complete the switch if needed
      if (session.state === "SWITCHING") {
        const previousResourceId = session.activeResourceId;

        // entitlementId comes from the validated bridge result
        await db.connectivitySession.update({
          where: { id: session.id },
          data: {
            activeResourceId: targetResourceId,
            entitlementId: bridgeResult.entitlementId,
            lastObservedAt: new Date(),
          },
        });
        await transitionSessionState(session.id, "ACTIVE");

        // Phase 8.5.9: Recovery old-release failure → RECONCILIATION_REQUIRED
        // (not swallowed .catch — same invariant as normal SWITCH)
        let oldReleaseFailed = false;
        if (previousResourceId && previousResourceId !== targetResourceId) {
          const releaseResult = await releaseResource(previousResourceId, session.id);
          if (!releaseResult.released) {
            oldReleaseFailed = true;
            logger.warn("recovery.switch_old_release_failed", {
              actionId: action.id,
              oldResourceId: previousResourceId,
              reason: releaseResult.reason,
            });
          }
        }

        if (oldReleaseFailed) {
          await transitionActionState(action.id, "RECONCILIATION_REQUIRED", `Recovery: old resource ${previousResourceId} release failed — session on target but cleanup needed`);
          reconciliationRequired++;
          continue;
        }
      }

      await transitionActionState(action.id, "SUCCEEDED");
      succeeded++;
      logger.info("action.recovered_succeeded", { actionId: action.id, targetResourceId, verified: true });
    } else if (resource.state === "RESERVED" && resource.reservedBy === session.id) {
      await releaseResource(targetResourceId, session.id);
      if (session.state === "SWITCHING") {
        await transitionSessionState(session.id, "ACTIVE");
      }
      await transitionActionState(action.id, "FAILED", "Resource was RESERVED but never IN_USE — recovered by releasing");
      failed++;
      logger.info("action.recovered_failed_reserved", { actionId: action.id, targetResourceId });
    } else {
      await transitionActionState(action.id, "RECONCILIATION_REQUIRED", `Resource in unexpected state: ${resource.state}, reservedBy: ${resource.reservedBy}`);
      reconciliationRequired++;
      logger.warn("action.recovered_reconciliation_required", {
        actionId: action.id,
        targetResourceId,
        resourceState: resource.state,
        reservedBy: resource.reservedBy,
      });
    }
  }

  const recovered = staleActions.length;
  logger.info("action.recovery_completed", {
    recovered, succeeded, failed, reconciliationRequired, claimId,
  });

  return { recovered, succeeded, failed, reconciliationRequired };
}
