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

/** Lease duration for a claimed decision. A crashed worker's claim expires after this. */
export const DECISION_EXECUTION_LEASE_MS = 5 * 60_000; // 5 minutes — action execution can be slow
/** Max attempts before a decision is dead-lettered (poison-decision protection). */
export const DECISION_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionExecutionResult = {
  decisionId: string;
  executionState: "EXECUTED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SKIPPED";
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
  if (claimable.executionAttemptCount >= DECISION_MAX_ATTEMPTS) {
    await db.connectivityDecision.update({
      where: { id: claimable.id },
      data: {
        executionState: DECISION_DEAD_LETTER,
        executedAt: new Date(),
      },
    }).catch(() => {});
    logger.error("decision.dead_lettered_at_claim", {
      decisionId: claimable.id,
      attemptCount: claimable.executionAttemptCount,
      maxAttempts: DECISION_MAX_ATTEMPTS,
    });
    // Recurse to try the next claimable decision.
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

  // P1-5 (9.4.2): Execution-time intent authority check. Before executing a
  // PENDING decision, verify the referenced intent is still ACTIVE and not
  // expired/superseded. A superseded intent cannot produce an action.
  if (decision.intentId && decision.intentVersion) {
    const { isIntentExpired } = await import("./intent-service");
    const expired = await isIntentExpired(decision.intentId, decision.intentVersion);
    if (expired) {
      await db.connectivityDecision.update({
        where: { id: decisionId },
        data: {
          executionState: DECISION_SKIPPED,
          executedAt: new Date(),
        },
      });
      logger.warn("decision.execution_skipped_intent_expired", {
        decisionId, intentId: decision.intentId, intentVersion: decision.intentVersion,
      });
      return {
        decisionId,
        executionState: "SKIPPED",
        error: "intent-expired-or-superseded",
      };
    }
  }

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

  // Phase 11.1: Poison-decision check — don't claim a decision that has
  // already exceeded MAX_ATTEMPTS. Dead-letter it instead.
  if (decision.executionAttemptCount >= DECISION_MAX_ATTEMPTS) {
    await db.connectivityDecision.update({
      where: { id: decisionId },
      data: {
        executionState: DECISION_DEAD_LETTER,
        executedAt: new Date(),
      },
    }).catch(() => {});
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

  // Create + execute the action.
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

    const execResult = await executeAction(action.id);

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
 * Returns { reclaimed, deadLettered } so callers can observe both outcomes.
 */
export async function reclaimExpiredDecisionClaims(): Promise<{ reclaimed: number; deadLettered: number }> {
  const now = new Date();

  // Find expired-claim decisions.
  const expired = await db.connectivityDecision.findMany({
    where: {
      executionState: DECISION_EXECUTION_CLAIMED,
      executionClaimExpiresAt: { lt: now },
    },
    select: { id: true, executionAttemptCount: true },
    take: 100,
  });

  let reclaimed = 0;
  let deadLettered = 0;

  for (const decision of expired) {
    if (decision.executionAttemptCount >= DECISION_MAX_ATTEMPTS) {
      // Phase 11.1: Poison decision — dead-letter, don't retry.
      await db.connectivityDecision.update({
        where: { id: decision.id },
        data: {
          executionState: DECISION_DEAD_LETTER,
          executedAt: now,
        },
      }).catch(() => {});
      deadLettered++;
      logger.error("decision.dead_lettered_at_reclaim", {
        decisionId: decision.id,
        attemptCount: decision.executionAttemptCount,
        maxAttempts: DECISION_MAX_ATTEMPTS,
      });
    } else {
      // Return to PENDING for retry.
      await db.connectivityDecision.update({
        where: { id: decision.id },
        data: {
          executionState: DECISION_PENDING,
          executionClaimId: null,
          executionClaimedAt: null,
        },
      }).catch(() => {});
      reclaimed++;
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
