/**
 * Control Plane — Decision Executor (Phase 8.6.5 + 8.6.6)
 *
 * Turns PENDING ConnectivityDecisions into ConnectivityActions. This is the
 * component that MUTATES session/resource/adapter state — deliberately
 * separated from the reevaluation worker, which only decides WHAT to do
 * (read-only evaluation).
 *
 * Phase 8.6.6 hardening:
 *   - FENCED EXECUTION. A decision is claimed atomically (PENDING →
 *     EXECUTION_CLAIMED) before execution. Only the worker holding
 *     executionClaimId may execute. This prevents two workers from racing
 *     through provider side effects on the same decision. Expired claims are
 *     reclaimable (same pattern as action/event recovery).
 *   - RECONCILIATION PROPAGATION. executeAction now returns
 *     "reconciliation_required" (not "succeeded") when the action needs
 *     cleanup. The decision-executor maps this to
 *     executionState=RECONCILIATION_REQUIRED (not EXECUTED), so the state
 *     model is consistent: Action state === Decision execution state.
 *
 * Boundary:
 *   ReevaluationEvent → [reevaluation worker] → ConnectivityDecision (PENDING)
 *   ConnectivityDecision (PENDING) → [claim] → EXECUTION_CLAIMED
 *        → [decision-executor] → ConnectivityAction
 *        → [action-executor] → kernel bridge → adapter → provider truth
 *        → EXECUTED | FAILED | RECONCILIATION_REQUIRED
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createAction, executeAction } from "./action-executor";
import {
  acquireSessionExecutionSlot,
  releaseSessionExecutionSlot,
  renewSessionExecutionSlot,
  createSlotOwnershipContext,
  SESSION_EXECUTION_SLOT_RENEWAL_INTERVAL_MS,
  type SlotOwnershipContext,
} from "./session-execution-slot";

// ---------------------------------------------------------------------------
// Lifecycle constants (Phase 8.6.6)
// ---------------------------------------------------------------------------

export const DECISION_PENDING = "PENDING" as const;
export const DECISION_EXECUTION_CLAIMED = "EXECUTION_CLAIMED" as const;
export const DECISION_EXECUTING = "EXECUTING" as const;
export const DECISION_EXECUTED = "EXECUTED" as const;
export const DECISION_FAILED = "FAILED" as const;
export const DECISION_RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED" as const;
export const DECISION_SKIPPED = "SKIPPED" as const;
export const DECISION_DEAD_LETTER = "DEAD_LETTER" as const;

/**
 * Phase 11.2: A special result for "session-busy-requeued." This is NOT a
 * persisted executionState — the decision is returned to PENDING. It's a
 * return-value-only state so the caller (executePendingDecisions) can track
 * it in results. The decision stays PENDING and will be retried on a future
 * worker iteration when the session slot is free.
 */
export const DECISION_SESSION_BUSY = "SESSION_BUSY" as const;

/** Lease duration for a claimed decision. A crashed worker's claim expires after this. */
export const DECISION_EXECUTION_LEASE_MS = 5 * 60_000; // 5 minutes — action execution can be slow
/** Max attempts before a decision is dead-lettered (poison-decision protection). */
export const DECISION_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionExecutionResult = {
  decisionId: string;
  // EXECUTED | FAILED | RECONCILIATION_REQUIRED | SKIPPED are persisted on the decision row.
  // SESSION_BUSY is a return-value-only state (Phase 11.2): the decision was
  // returned to PENDING because the session slot was held by another worker.
  executionState: "EXECUTED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SKIPPED" | "SESSION_BUSY";
  actionId?: string;
  actionStatus?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Phase 8.6.6: Fenced decision claim
// ---------------------------------------------------------------------------

/**
 * Atomically claim a PENDING (or expired-claim) decision for execution.
 * Returns the claimed decision, or null if none were available.
 *
 * A decision is claimable if:
 *   - executionState = PENDING, OR
 *   - executionState = EXECUTION_CLAIMED AND executionClaimExpiresAt < now
 *
 * The claim is atomic (updateMany with a WHERE guard) so two concurrent
 * workers cannot both claim the same decision.
 */
export async function claimDecisionForExecution(
  workerId: string,
  filter?: { decisionId?: string; sessionId?: string },
): Promise<{
  id: string;
  action: string;
  sessionId: string | null;
  targetResourceId: string | null;
  reasons: string | null;
  attemptCount: number;
} | null> {
  const now = new Date();
  const claimId = `decexec-claim-${workerId}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const claimExpiresAt = new Date(now.getTime() + DECISION_EXECUTION_LEASE_MS);

  // Find the oldest claimable non-KEEP decision. An optional filter scopes the
  // claim to a specific decision or session (parallel to claimReevaluationEvent).
  const claimable = await db.connectivityDecision.findFirst({
    where: {
      OR: [
        { executionState: DECISION_PENDING },
        { executionState: DECISION_EXECUTION_CLAIMED, executionClaimExpiresAt: { lt: now } },
      ],
      action: { notIn: ["KEEP", "WAIT", "ASK_USER"] },
      ...(filter?.decisionId ? { id: filter.decisionId } : {}),
      ...(filter?.sessionId ? { sessionId: filter.sessionId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  if (!claimable) return null;

  // Phase 11.1: Poison-decision protection. If this decision has already been
  // claimed DECISION_MAX_ATTEMPTS times (the worker crashed mid-execution each
  // time, the lease expired, and reclaimExpiredDecisionClaims returned it to
  // PENDING), dead-letter it instead of claiming. This is a defensive check —
  // reclaimExpiredDecisionClaims is the primary dead-letter checkpoint, but
  // this catches any decision that somehow reached PENDING with attemptCount >= MAX.
  //
  // Phase 11.1.1 (fenced): The dead-letter transition MUST be DB-authoritative.
  // The read above and this write are separate operations, so an unfenced
  // update would race with another worker's claim:
  //   Worker A reads: PENDING, attempts=3
  //   Worker B claims: PENDING → EXECUTION_CLAIMED (fenced, increments to 4)
  //   Worker A dead-letters: overwrites EXECUTION_CLAIMED → DEAD_LETTER
  // This destroys Worker B's claim mid-execution. The fix: make the dead-letter
  // itself a fenced updateMany with WHERE guards on state + attemptCount.
  // If count=0, another worker already changed the state (claimed it or already
  // dead-lettered it) — do NOT overwrite; recurse to the next decision.
  if (claimable.executionAttemptCount >= DECISION_MAX_ATTEMPTS) {
    const deadLetterResult = await db.connectivityDecision.updateMany({
      where: {
        id: claimable.id,
        executionState: DECISION_PENDING, // still PENDING (not claimed by someone else)
        executionAttemptCount: { gte: DECISION_MAX_ATTEMPTS }, // still at/over MAX
      },
      data: {
        executionState: DECISION_DEAD_LETTER,
        executedAt: new Date(),
      },
    });

    if (deadLetterResult.count > 0) {
      logger.error("decision.dead_lettered_at_claim", {
        decisionId: claimable.id,
        attemptCount: claimable.executionAttemptCount,
        maxAttempts: DECISION_MAX_ATTEMPTS,
      });
    }
    // Whether we dead-lettered it or another worker beat us to it, this
    // decision is no longer claimable by us. Recurse to try the next one.
    return claimDecisionForExecution(workerId, filter);
  }

  // Fenced update: only transition if still claimable. Increment attemptCount.
  const result = await db.connectivityDecision.updateMany({
    where: {
      id: claimable.id,
      OR: [
        { executionState: DECISION_PENDING },
        { executionState: DECISION_EXECUTION_CLAIMED, executionClaimExpiresAt: { lt: now } },
      ],
    },
    data: {
      executionState: DECISION_EXECUTION_CLAIMED,
      executionClaimId: claimId,
      executionClaimedAt: now,
      executionClaimExpiresAt: claimExpiresAt,
      executionAttemptCount: { increment: 1 },
    },
  });

  if (result.count === 0) {
    // Another worker beat us — try the next one.
    return claimDecisionForExecution(workerId, filter);
  }

  const newAttemptCount = claimable.executionAttemptCount + 1;
  logger.info("decision.claimed", {
    decisionId: claimable.id, claimId, attemptCount: newAttemptCount,
  });

  return {
    id: claimable.id,
    action: claimable.action,
    sessionId: claimable.sessionId,
    targetResourceId: claimable.targetResourceId,
    reasons: claimable.reasons,
    attemptCount: newAttemptCount,
  };
}

// ---------------------------------------------------------------------------
// Execute a single PENDING decision (fenced)
// ---------------------------------------------------------------------------

/**
 * Execute a PENDING non-KEEP decision: create + execute the ConnectivityAction.
 *
 * Phase 8.6.6: This function assumes the caller has NOT claimed the decision.
 * It claims atomically before executing, so two concurrent calls are safe —
 * only one proceeds to execution.
 *
 * KEEP/WAIT/ASK_USER decisions have executionState SKIPPED (no action needed).
 *
 * Idempotent: if the decision is already EXECUTED/FAILED/RECONCILIATION_REQUIRED/SKIPPED,
 * it is a no-op.
 */
export async function executeDecision(decisionId: string): Promise<DecisionExecutionResult> {
  const decision = await db.connectivityDecision.findUnique({
    where: { id: decisionId },
    select: { id: true, sessionId: true, action: true, targetResourceId: true, reasons: true, executionState: true, intentId: true, intentVersion: true, executionAttemptCount: true },
  });

  if (!decision) {
    return { decisionId, executionState: "FAILED", error: "decision-not-found" };
  }

  // Idempotent: already in a terminal state.
  if (![DECISION_PENDING, DECISION_EXECUTION_CLAIMED].includes(decision.executionState as typeof DECISION_PENDING)) {
    return {
      decisionId,
      executionState: decision.executionState as "EXECUTED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SKIPPED",
    };
  }

  // Phase 11.4.5: The intent-expiry check has been MOVED to after the claim
  // (below). It was previously a preflight check before the claim, which
  // created a TOCTOU: intent valid at check → intent expires → claim → execute.
  // Now: claim first → verify intent authority (fenced by claim) → execute.
  // "Intent authority is not a preflight check. It is an execution boundary."

  // KEEP/WAIT/ASK_USER → SKIPPED (no action).
  if (["KEEP", "WAIT", "ASK_USER"].includes(decision.action)) {
    await db.connectivityDecision.update({
      where: { id: decisionId },
      data: { executionState: DECISION_SKIPPED, executedAt: new Date() },
    });
    return { decisionId, executionState: "SKIPPED" };
  }

  // Phase 8.6.6: Fenced claim — only one worker may proceed.
  // Phase 11.1: Increment executionAttemptCount at claim time (same as
  // claimDecisionForExecution). This is the direct-call path (reevaluation
  // worker calls executeDecision after producing a decision).
  const now = new Date();
  const claimId = `decexec-${decisionId}-${now.getTime()}`;
  const claimExpiresAt = new Date(now.getTime() + DECISION_EXECUTION_LEASE_MS);

  // Phase 11.1: Poison-decision check — don't claim a PENDING decision that
  // has already exceeded MAX_ATTEMPTS. Dead-letter it instead.
  //
  // Phase 11.1.1 (fenced): The dead-letter transition MUST be DB-authoritative.
  // The read above (findUnique) and this write are separate operations, so an
  // unfenced update would race with another worker's claim (same TOCTOU as
  // claimDecisionForExecution). The fix: fenced updateMany with WHERE guards
  // on state + attemptCount. If count=0, another worker already changed the
  // state — return the current state, do NOT overwrite it.
  //
  // Phase 11.1.2 (active-claim protection): The poison check must ONLY
  // dead-letter a PENDING decision. An EXECUTION_CLAIMED decision belongs to
  // the claim owner until its lease expires — even if attemptCount >= MAX
  // (which can legitimately happen: a worker claims at attempts=MAX-1,
  // increments to MAX, and is mid-execution). A second caller dead-lettering
  // an EXECUTION_CLAIMED decision would destroy the active claim. The
  // authoritative path for dead-lettering an expired EXECUTION_CLAIMED claim
  // is reclaimExpiredDecisionClaims() (which checks claim-expiry).
  //
  // Lifecycle:
  //   PENDING, attempts=MAX
  //       → executeDecision() → DEAD_LETTER (poison check, PENDING only)
  //   EXECUTION_CLAIMED, attempts=MAX (active claim, lease not expired)
  //       → another executeDecision() → claim fails (already-claimed)
  //       → existing worker remains authoritative
  //   EXECUTION_CLAIMED + expired lease, attempts=MAX
  //       → reclaimExpiredDecisionClaims() → DEAD_LETTER (claim-expiry guarded)
  if (decision.executionAttemptCount >= DECISION_MAX_ATTEMPTS && decision.executionState === DECISION_PENDING) {
    const deadLetterResult = await db.connectivityDecision.updateMany({
      where: {
        id: decisionId,
        executionState: DECISION_PENDING, // ONLY PENDING — never an active EXECUTION_CLAIMED claim
        executionAttemptCount: { gte: DECISION_MAX_ATTEMPTS }, // still at/over MAX
      },
      data: {
        executionState: DECISION_DEAD_LETTER,
        executedAt: new Date(),
      },
    });

    if (deadLetterResult.count > 0) {
      logger.error("decision.dead_lettered_at_execute", {
        decisionId,
        attemptCount: decision.executionAttemptCount,
        maxAttempts: DECISION_MAX_ATTEMPTS,
      });
      return {
        decisionId,
        executionState: "FAILED",
        error: `dead-lettered:max-attempts (${decision.executionAttemptCount} >= ${DECISION_MAX_ATTEMPTS})`,
      };
    }
    // count=0: another worker changed the state (claimed it, executed it, or
    // already dead-lettered it). Re-read and return the current state rather
    // than overwriting it.
    const current = await db.connectivityDecision.findUnique({
      where: { id: decisionId },
      select: { executionState: true },
    });
    return {
      decisionId,
      executionState: (current?.executionState as "EXECUTED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SKIPPED") ?? "FAILED",
      error: "decision-state-changed-concurrently",
    };
  }

  const claimResult = await db.connectivityDecision.updateMany({
    where: {
      id: decisionId,
      executionState: { in: [DECISION_PENDING, DECISION_EXECUTION_CLAIMED] },
      OR: [
        { executionState: DECISION_PENDING },
        { executionState: DECISION_EXECUTION_CLAIMED, executionClaimExpiresAt: { lt: now } },
      ],
    },
    data: {
      executionState: DECISION_EXECUTION_CLAIMED,
      executionClaimId: claimId,
      executionClaimedAt: now,
      executionClaimExpiresAt: claimExpiresAt,
      executionAttemptCount: { increment: 1 },
    },
  });

  if (claimResult.count === 0) {
    // Another worker claimed it first — re-read and return current state.
    const current = await db.connectivityDecision.findUnique({
      where: { id: decisionId },
      select: { executionState: true },
    });
    return {
      decisionId,
      executionState: (current?.executionState as "EXECUTED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SKIPPED") ?? "FAILED",
      error: "decision-already-claimed",
    };
  }

  // Mark EXECUTING
  await db.connectivityDecision.update({
    where: { id: decisionId },
    data: { executionState: DECISION_EXECUTING },
  });

  // Phase 11.4.5: Claim-first intent authority check.
  // The intent-expiry check now happens AFTER the claim is established.
  // This eliminates the TOCTOU where the intent was valid at check time but
  // expired before the claim/execution.
  //
  // Phase 11.4.6: The SKIP transition is fenced by BOTH executionState = EXECUTING
  // AND executionClaimId = claimId. Only the claim owner can transition to SKIPPED.
  // EXECUTING alone is not ownership — the claimId is the authoritative ownership
  // predicate (same rule as 11.1/11.2).
  //
  // "Intent authority is not a preflight check. It is an execution boundary."
  if (decision.intentId && decision.intentVersion) {
    const { isIntentExpired } = await import("./intent-service");
    const expired = await isIntentExpired(decision.intentId, decision.intentVersion);
    if (expired) {
      // Fenced SKIP: only transition to SKIPPED if we still own the claim.
      // WHERE executionState = EXECUTING AND executionClaimId = claimId.
      const skipResult = await db.connectivityDecision.updateMany({
        where: {
          id: decisionId,
          executionState: DECISION_EXECUTING,
          executionClaimId: claimId, // fenced — only the claim owner can SKIP
        },
        data: {
          executionState: DECISION_SKIPPED,
          executedAt: new Date(),
        },
      });

      if (skipResult.count > 0) {
        logger.warn("decision.execution_skipped_intent_expired", {
          decisionId, intentId: decision.intentId, intentVersion: decision.intentVersion,
        });
        return {
          decisionId,
          executionState: "SKIPPED",
          error: "intent-expired-or-superseded",
        };
      }
      // count=0: another worker changed the state (shouldn't happen — we own
      // the claim). Return the current state without overwriting.
      const current = await db.connectivityDecision.findUnique({
        where: { id: decisionId },
        select: { executionState: true },
      });
      return {
        decisionId,
        executionState: (current?.executionState as "EXECUTED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SKIPPED") ?? "FAILED",
        error: "decision-state-changed-concurrently",
      };
    }
  }

  // Phase 11.2: Session-level execution serialization.
  // Acquire the session execution slot BEFORE creating/executing the action.
  // The slot owns the ENTIRE mutation window (create action → execute → verify).
  // If the slot is busy (another decision is mutating this session), requeue
  // the decision (return to PENDING) — do NOT fail or dead-letter it.
  // "Session busy" is a legitimate "try later" condition.
  //
  // This prevents two concurrent SWITCH decisions (A→B and A→C) for the same
  // session from both executing and racing on session.activeResourceId.
  let sessionSlotClaimId: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Phase 11.2.2: The slot ownership context is shared between the heartbeat
  // (which sets slotLost on renewal failure) and executeAction (which checks
  // it before each mutating stage). Declared here so it's in scope for both.
  let slotOwnershipContext: SlotOwnershipContext | undefined = undefined;
  if (decision.sessionId) {
    sessionSlotClaimId = `slot-${decisionId}-${Date.now()}`;
    const slotResult = await acquireSessionExecutionSlot(decision.sessionId, sessionSlotClaimId);
    if (!slotResult.acquired) {
      // Session is being mutated by another worker. Requeue the decision:
      // return it to PENDING (release the execution claim) so it can be
      // retried on a future worker iteration when the slot is free.
      // The attemptCount stays incremented (the claim did happen).
      //
      // Phase 11.2.1 (fenced): The requeue MUST be fenced by the execution
      // claim that owns EXECUTING. An unconditional update would race with a
      // concurrent worker's claim after lease expiry:
      //   Worker A holds EXECUTING, slot busy → pauses
      //   A's decision lease expires → reclaim → PENDING
      //   Worker B claims → EXECUTION_CLAIMED
      //   Worker A resumes → unconditional requeue → overwrites B's claim
      // The fix: fenced updateMany WHERE executionState=EXECUTING AND
      // executionClaimId = claimId (Worker A's). If count=0, Worker A has lost
      // ownership and must not mutate the decision.
      const requeueResult = await db.connectivityDecision.updateMany({
        where: {
          id: decisionId,
          executionState: DECISION_EXECUTING,
          executionClaimId: claimId, // fenced — only Worker A's claim requeues
        },
        data: {
          executionState: DECISION_PENDING,
          executionClaimId: null,
          executionClaimedAt: null,
        },
      });
      if (requeueResult.count > 0) {
        logger.info("decision.session_busy_requeued", {
          decisionId, sessionId: decision.sessionId,
        });
      } else {
        // count=0: Worker A lost ownership (lease expired, decision reclaimed
        // and re-claimed by another worker). Do NOT mutate the decision —
        // another worker now owns it.
        logger.warn("decision.session_busy_requeue_skipped", {
          decisionId, reason: "execution-claim-no-longer-owned-by-this-worker",
        });
      }
      return {
        decisionId,
        executionState: "SESSION_BUSY",
        error: "session-execution-slot-held-by-another-worker",
      };
    }

    // Phase 11.2.1: Start a heartbeat that renews the session slot lease
    // periodically while the mutation is running. This guarantees the slot
    // cannot expire mid-mutation — the invariant:
    //   "A session execution slot MUST NOT become available while its owner
    //    is still performing the mutation window."
    //
    // Phase 11.2.2: On renewal failure, set slotOwnershipContext.slotLost = true.
    // The action executor checks this before each mutating stage and aborts
    // safely (RECONCILIATION_REQUIRED) if the slot was lost. This closes the
    // gap where a failed renewal was merely logged and the mutation continued.
    slotOwnershipContext = createSlotOwnershipContext(decision.sessionId, sessionSlotClaimId);
    heartbeatTimer = setInterval(async () => {
      if (sessionSlotClaimId && decision.sessionId && slotOwnershipContext) {
        try {
          const result = await renewSessionExecutionSlot(decision.sessionId, sessionSlotClaimId);
          if (!result.renewed) {
            // Phase 11.2.2: Slot lost — flag it so the next ownership checkpoint aborts.
            slotOwnershipContext.slotLost = true;
          }
        } catch (err) {
          // Phase 11.2.2: Renewal threw — flag as lost.
          slotOwnershipContext.slotLost = true;
          logger.error("decision.slot_heartbeat_error", {
            decisionId, sessionId: decision.sessionId, claimId: sessionSlotClaimId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, SESSION_EXECUTION_SLOT_RENEWAL_INTERVAL_MS);
  }

  // Phase 11.4.6: Durable intent-authority fence at the mutation boundary.
  // After the session slot is acquired (the mutation window is about to open),
  // verify intent authority ONE FINAL TIME inside a DB transaction. This
  // prevents the TOCTOU where the intent was valid at the post-claim check
  // but expires/superseded before the resource mutation begins.
  //
  // "Intent authority must be bound to the execution claim at the mutation boundary."
  //
  // If the intent is no longer authorized, the decision transitions to SKIPPED
  // (fenced by executionClaimId) inside the transaction. No action is created,
  // no resource mutation occurs.
  if (decision.intentId && decision.intentVersion) {
    const { verifyIntentAuthorityAtBoundary } = await import("./intent-authority");
    const authorityResult = await verifyIntentAuthorityAtBoundary(
      decisionId,
      claimId,
      decision.intentId,
      decision.intentVersion,
    );
    if (!authorityResult.authorized) {
      // Release the session slot (we acquired it above).
      if (sessionSlotClaimId && decision.sessionId) {
        await releaseSessionExecutionSlot(decision.sessionId, sessionSlotClaimId);
      }
      // Stop the heartbeat.
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      return {
        decisionId,
        executionState: "SKIPPED",
        error: `intent-authority-fence-rejected: ${authorityResult.reason}`,
      };
    }
  }

  // Create + execute the action. The session slot is released in a finally
  // block — regardless of success/failure/reconciliation, the slot MUST be
  // released so the next decision for the session can execute.
  //
  // Phase 11.2.2: slotOwnershipContext is passed to executeAction so it can
  // verify slot ownership before each mutating stage. If the slot was lost
  // (heartbeat renewal failed), executeAction aborts safely →
  // RECONCILIATION_REQUIRED.
  try {
    const reasons = decision.reasons ? JSON.parse(decision.reasons) as string[] : [];
    const action = await createAction({
      sessionId: decision.sessionId!,
      decisionId: decision.id,
      type: decision.action as "ACTIVATE" | "SWITCH" | "RESERVE" | "RENEW" | "RELEASE",
      targetResourceId: decision.targetResourceId ?? undefined,
      reason: reasons.join("; ") || undefined,
      idempotencyKey: `decexec-${decision.id}`,
    });

    const execResult = await executeAction(action.id, slotOwnershipContext);

    // Phase 8.6.6: Map action status → decision execution state explicitly.
    // "reconciliation_required" is NOT "succeeded" — propagate it.
    let finalState: DecisionExecutionResult["executionState"];
    if (execResult.status === "succeeded") {
      finalState = "EXECUTED";
    } else if (execResult.status === "reconciliation_required") {
      finalState = "RECONCILIATION_REQUIRED";
    } else {
      finalState = "FAILED";
    }

    await db.connectivityDecision.update({
      where: { id: decisionId },
      data: {
        executionState: finalState,
        executedAt: new Date(),
        executedActionId: action.id,
      },
    });

    logger.info("decision.executed", {
      decisionId, action: decision.action, actionId: action.id,
      actionStatus: execResult.status, decisionState: finalState,
    });

    return {
      decisionId,
      executionState: finalState,
      actionId: action.id,
      actionStatus: execResult.status,
      error: execResult.error,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.connectivityDecision.update({
      where: { id: decisionId },
      data: { executionState: DECISION_FAILED, executedAt: new Date() },
    });
    logger.error("decision.execution_error", { decisionId, error: errorMsg });
    return { decisionId, executionState: "FAILED", error: errorMsg };
  } finally {
    // Phase 11.2.1: Stop the heartbeat first (no more renewals after the
    // mutation completes).
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    // Phase 11.2: Release the session execution slot. Fenced by claimId —
    // only the claim owner releases. If the slot was reclaimed after lease
    // expiry (crashed worker), this is a no-op (count=0, safe).
    if (sessionSlotClaimId && decision.sessionId) {
      await releaseSessionExecutionSlot(decision.sessionId, sessionSlotClaimId);
    }
  }
}

// ---------------------------------------------------------------------------
// Reclaim expired decision claims (cron cleanup)
// ---------------------------------------------------------------------------

/**
 * Reclaim decisions whose execution claims have expired (the worker died
 * mid-execution). Returns them to PENDING so another worker can retry.
 *
 * Phase 11.1: Dead-letter decisions that have exceeded DECISION_MAX_ATTEMPTS.
 * This is the primary poison-decision checkpoint — the crash-retry loop
 * (EXECUTION_CLAIMED → lease expires → PENDING → claim → crash → ...) is
 * bounded: after DECISION_MAX_ATTEMPTS claims, the decision is dead-lettered
 * instead of being returned to PENDING. Parallel to ReevaluationEvent
 * dead-lettering in reclaimExpiredClaims().
 *
 * Phase 11.1.1 (fenced): Both transitions (→ DEAD_LETTER and → PENDING) use
 * fenced updateMany with WHERE guards on state + claim-expiry. The findMany
 * read and each per-decision write are separate operations, so an unfenced
 * update would race with a concurrent worker's claim:
 *   reclaim reads: EXECUTION_CLAIMED, expired, attempts=2
 *   worker claims it: EXECUTION_CLAIMED → re-claims + increments to 3
 *   reclaim overwrites: → PENDING (destroying the new claim)
 * The fix: each update includes `executionState: EXECUTION_CLAIMED` and
 * `executionClaimExpiresAt: { lt: now }` in the WHERE guard. If count=0,
 * another worker already changed the state — skip it (don't overwrite).
 *
 * Returns { reclaimed, deadLettered } so callers can observe both outcomes.
 */
export async function reclaimExpiredDecisionClaims(): Promise<{ reclaimed: number; deadLettered: number }> {
  const now = new Date();

  // Phase 11.2.1: Find expired-claim decisions in BOTH EXECUTION_CLAIMED and
  // EXECUTING states. A worker that crashes after marking EXECUTING (but before
  // completing the action) leaves the decision in EXECUTING with an expired
  // claim. Both states must be reclaimable — otherwise an EXECUTING decision
  // with an expired lease is stuck forever (no worker can claim it because
  // claimDecisionForExecution only finds PENDING/EXECUTION_CLAIMED).
  const expired = await db.connectivityDecision.findMany({
    where: {
      executionState: { in: [DECISION_EXECUTION_CLAIMED, DECISION_EXECUTING] },
      executionClaimExpiresAt: { lt: now },
    },
    select: { id: true, executionAttemptCount: true, executionState: true },
    take: 100,
  });

  let reclaimed = 0;
  let deadLettered = 0;

  for (const decision of expired) {
    // Phase 11.1.1: Fenced transition — only update if still in the same
    // non-terminal state with an expired lease. A concurrent worker may have
    // already changed the state. We must NOT overwrite that.
    const stateFilter = decision.executionState; // EXECUTION_CLAIMED or EXECUTING

    if (decision.executionAttemptCount >= DECISION_MAX_ATTEMPTS) {
      // Phase 11.1: Poison decision — dead-letter, don't retry.
      const result = await db.connectivityDecision.updateMany({
        where: {
          id: decision.id,
          executionState: stateFilter, // still in the same state (not changed since read)
          executionClaimExpiresAt: { lt: now }, // still expired
          executionAttemptCount: { gte: DECISION_MAX_ATTEMPTS }, // still at/over MAX
        },
        data: {
          executionState: DECISION_DEAD_LETTER,
          executedAt: now,
        },
      });
      if (result.count > 0) {
        deadLettered++;
        logger.error("decision.dead_lettered_at_reclaim", {
          decisionId: decision.id,
          attemptCount: decision.executionAttemptCount,
          maxAttempts: DECISION_MAX_ATTEMPTS,
          fromState: stateFilter,
        });
      }
      // If count=0: another worker changed the state. Skip — don't overwrite.
    } else {
      // Return to PENDING for retry.
      const result = await db.connectivityDecision.updateMany({
        where: {
          id: decision.id,
          executionState: stateFilter, // still in the same state
          executionClaimExpiresAt: { lt: now }, // still expired
          executionAttemptCount: { lt: DECISION_MAX_ATTEMPTS }, // still under MAX
        },
        data: {
          executionState: DECISION_PENDING,
          executionClaimId: null,
          executionClaimedAt: null,
        },
      });
      if (result.count > 0) {
        reclaimed++;
      }
      // If count=0: another worker changed the state. Skip — don't overwrite.
    }
  }

  if (reclaimed > 0 || deadLettered > 0) {
    logger.info("decision.claims_reclaimed", { reclaimed, deadLettered });
  }
  return { reclaimed, deadLettered };
}

// ---------------------------------------------------------------------------
// Execute all PENDING decisions (worker entry point — fenced)
// ---------------------------------------------------------------------------

/**
 * Find all PENDING non-KEEP decisions and execute them with fenced claims.
 *
 * Phase 8.6.6: Each decision is claimed atomically before execution, so two
 * concurrent workers cannot race on the same decision.
 */
export async function executePendingDecisions(limit = 20, workerId = `decexec-${Date.now()}`): Promise<{ executed: number; results: Record<string, number> }> {
  const results: Record<string, number> = {};
  let executed = 0;

  for (let i = 0; i < limit; i++) {
    // Claim one decision at a time (fenced).
    const claimed = await claimDecisionForExecution(workerId);
    if (!claimed) break;

    // KEEP/WAIT/ASK_USER should not reach here (filtered in claim), but guard.
    if (["KEEP", "WAIT", "ASK_USER"].includes(claimed.action)) {
      await db.connectivityDecision.update({
        where: { id: claimed.id },
        data: { executionState: DECISION_SKIPPED, executedAt: new Date() },
      }).catch(() => {});
      results["SKIPPED"] = (results["SKIPPED"] ?? 0) + 1;
      executed++;
      continue;
    }

    // Mark EXECUTING and execute.
    await db.connectivityDecision.update({
      where: { id: claimed.id },
      data: { executionState: DECISION_EXECUTING },
    }).catch(() => {});

    const res = await executeDecision(claimed.id);
    results[res.executionState] = (results[res.executionState] ?? 0) + 1;
    executed++;
  }
  return { executed, results };
}
