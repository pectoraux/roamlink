/**
 * Control Plane — Session-Level Execution Serialization (Phase 11.2)
 *
 * A DB-authoritative primitive that ensures a session may have at most one
 * connectivity mutation executing at a time. This closes the highest-risk
 * concurrency gap identified in the Phase 11 audit:
 *
 *   Two concurrent SWITCH decisions for the same session (A→B and A→C) can
 *   both be claimed by different workers, both proceed to execute, and race
 *   on session.activeResourceId — leaving the session on an unintended resource
 *   and the losing target orphaned IN_USE.
 *
 * The primitive owns the ENTIRE mutation window:
 *
 *   decision execution request
 *       ↓
 *   claim session execution slot  ← DB-authoritative fenced updateMany
 *       ↓
 *   perform connectivity mutation  (create + execute action)
 *       ↓
 *   verify convergence  (assertActiveConnectivityInvariant)
 *       ↓
 *   release session execution slot  ← fenced (only claim owner releases)
 *
 * NOT:
 *   check session → mutate → later discover someone else mutated it
 *
 * The slot is a column on ConnectivitySession (executionSlotClaimId +
 * executionSlotClaimExpiresAt). The acquire is a single UPDATE with a WHERE
 * guard — two workers cannot both acquire it. A crashed worker's slot is
 * reclaimable after lease expiry (reclaimExpiredSessionSlots).
 *
 * Acceptance invariant #2:
 *   "A session cannot have two connectivity mutations executing concurrently."
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Lease duration
// ---------------------------------------------------------------------------

/**
 * Lease duration for a session execution slot. A crashed worker's slot is
 * reclaimable after this. Matches DECISION_EXECUTION_LEASE_MS (5 min) — the
 * slot must cover the full action execution window (reserve → activate →
 * verify → release old).
 *
 * Phase 11.2.1: The lease is RENEWABLE. A heartbeat in executeDecision()
 * renews the lease periodically (every SESSION_EXECUTION_SLOT_RENEWAL_INTERVAL_MS)
 * while the mutation is running. This guarantees the slot cannot expire while
 * its owner is still performing the mutation window — the invariant:
 *   "A session execution slot MUST NOT become available while its owner is
 *    still performing the mutation window."
 *
 * Phase 11.2.5 (DUAL-PURPOSE LEASE — intentionally documented):
 * The session execution lease serves TWO purposes. A future agent must NOT
 * "simplify away" the per-mutation renewal as redundant with the heartbeat.
 *
 *   1. EXECUTION OWNERSHIP (authorization):
 *      The conditional session UPDATE inside withValidSessionExecutionLease()
 *      is the DB-level authorization fence for every resource mutation. It
 *      verifies the claim + renews the lease + takes the row lock — all in
 *      one atomic operation inside the same transaction as the resource
 *      mutation. Without this renewal, a concurrent reclaim could clear the
 *      claim between the authorization check and the resource mutation (TOCTOU).
 *
 *   2. EXECUTION LIVENESS (heartbeat):
 *      The heartbeat (setInterval in executeDecision) renews the lease
 *      periodically BETWEEN mutation boundaries — during long provider calls
 *      (e.g. adapter.getUsage) where no resource mutation is happening. This
 *      prevents the lease from expiring during a long non-mutating operation.
 *
 *   The per-mutation renewal (purpose 1) provides the hard authorization fence.
 *   The heartbeat (purpose 2) covers the gaps between mutations. Both are
 *   required. Removing either one reintroduces a TOCTOU or a liveness gap.
 */
export const SESSION_EXECUTION_SLOT_LEASE_MS = 5 * 60_000; // 5 minutes

/**
 * How often the heartbeat renews the slot lease. Must be substantially shorter
 * than the lease so that a single missed heartbeat doesn't let the lease
 * expire before the next renewal. 1/5 of the lease — even 4 missed heartbeats
 * in a row still leave time before expiry.
 */
export const SESSION_EXECUTION_SLOT_RENEWAL_INTERVAL_MS = 60_000; // 1 minute (lease is 5 min)

// ---------------------------------------------------------------------------
// Phase 11.2.2: Slot ownership context — lost-slot mutation prevention
// ---------------------------------------------------------------------------

/**
 * A shared mutable context that tracks whether the worker still owns the
 * session execution slot. The heartbeat sets `slotLost = true` when a renewal
 * fails. Before each mutating stage in the action executor, the worker calls
 * `verifySlotOwnership()` — if the slot was lost, the worker MUST NOT perform
 * another connectivity mutation.
 *
 * This closes the gap where a failed heartbeat renewal was merely logged,
 * allowing the mutation to continue after the slot was reclaimed by another worker.
 *
 * The invariant:
 *   "While a worker is performing the mutation window, either the worker still
 *    owns the session slot OR the worker has stopped before performing any
 *    further connectivity mutation."
 */
export type SlotOwnershipContext = {
  sessionId: string;
  claimId: string;
  slotLost: boolean;
  /**
   * Check whether the worker still owns the session slot. Called before each
   * mutating stage (reserve, activate, release-old). If the slot was lost
   * (heartbeat renewal failed), throws a SlotOwnershipLostError to abort the
   * mutation safely → RECONCILIATION_REQUIRED.
   *
   * Also performs a DB check (fenced read) to catch the case where the slot
   * was reclaimed by cron but the heartbeat hasn't fired yet.
   */
  verifySlotOwnership: () => Promise<void>;
};

/**
 * Error thrown when slot ownership is lost during a mutation. Caught by
 * executeAction → maps to RECONCILIATION_REQUIRED (not FAILED — the session
 * may be in an inconsistent state that needs reconciliation, not a clean failure).
 */
export class SlotOwnershipLostError extends Error {
  constructor(sessionId: string, claimId: string, reason: string) {
    super(`Session slot ownership lost (sessionId=${sessionId}, claimId=${claimId}): ${reason}. Mutation aborted — reconciliation required.`);
    this.name = "SlotOwnershipLostError";
  }
}

/**
 * Create a slot ownership context for a session + claim. The context is shared
 * between the heartbeat (which sets slotLost on renewal failure) and the action
 * executor (which calls verifySlotOwnership before each mutating stage).
 */
export function createSlotOwnershipContext(sessionId: string, claimId: string): SlotOwnershipContext {
  const ctx: SlotOwnershipContext = {
    sessionId,
    claimId,
    slotLost: false,
    verifySlotOwnership: async () => {
      // Fast path: if the heartbeat already flagged loss, abort immediately.
      if (ctx.slotLost) {
        throw new SlotOwnershipLostError(sessionId, claimId, "heartbeat renewal failed (flagged)");
      }
      // DB check: verify the slot is still held by this claim. This catches
      // the case where the slot was reclaimed by cron but the heartbeat
      // hasn't fired yet (e.g. the worker was blocked in a long provider call).
      const session = await db.connectivitySession.findUnique({
        where: { id: sessionId },
        select: { executionSlotClaimId: true, executionSlotClaimExpiresAt: true },
      });
      if (!session || session.executionSlotClaimId !== claimId) {
        ctx.slotLost = true;
        throw new SlotOwnershipLostError(sessionId, claimId, "slot claim no longer held (reclaimed or stolen)");
      }
      // Check lease expiry (defensive — the heartbeat should have renewed, but
      // if it didn't fire, the lease may have expired even though claimId matches).
      if (session.executionSlotClaimExpiresAt && session.executionSlotClaimExpiresAt < new Date()) {
        ctx.slotLost = true;
        throw new SlotOwnershipLostError(sessionId, claimId, "slot lease expired (heartbeat did not renew in time)");
      }
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Phase 11.2.3: DB-authoritative mutation fence — fencedSessionUpdate
// ---------------------------------------------------------------------------

/**
 * Phase 11.2.3: The checkpoint is a fast-path observation; the mutation itself
 * must carry the DB fence. This helper performs a session update that is
 * authorized by the currently valid session execution claim at the mutation
 * boundary — not merely preceded by a successful observation of ownership.
 *
 * The update is a fenced updateMany:
 *   WHERE id = sessionId
 *     AND executionSlotClaimId = claimId
 *     AND executionSlotClaimExpiresAt > now
 *   DATA: <the session fields to update>
 *
 * If count=0, the slot was lost (reclaimed/stolen/expired) between the
 * checkpoint and the mutation. The caller MUST treat this as a safety event
 * → RECONCILIATION_REQUIRED. The mutation did NOT happen.
 *
 * This closes the TOCTOU window:
 *   verifySlotOwnership() ← checkpoint (observation)
 *       ↓ [time passes]
 *   slot expires / reclaimed / stolen
 *       ↓
 *   fencedSessionUpdate() ← mutation is REJECTED (count=0, not authorized)
 *
 * The architectural rule:
 *   "Every state-changing connectivity mutation must be authorized by the
 *    currently valid session execution claim at the mutation boundary, not
 *    merely preceded by a successful observation of ownership."
 *
 * Returns { applied: boolean }. If false, the caller does NOT own the slot
 * at mutation time and must not proceed.
 */
export async function fencedSessionUpdate(
  sessionId: string,
  claimId: string,
  data: Record<string, unknown>,
): Promise<{ applied: boolean }> {
  const now = new Date();
  const result = await db.connectivitySession.updateMany({
    where: {
      id: sessionId,
      executionSlotClaimId: claimId, // fenced — only the claim owner mutates
      executionSlotClaimExpiresAt: { gt: now }, // lease must still be valid
    },
    data,
  });

  if (result.count > 0) {
    logger.info("session.fenced_update_applied", { sessionId, claimId });
    return { applied: true };
  }

  // count=0: slot was lost between the checkpoint and the mutation.
  logger.error("session.fenced_update_rejected", {
    sessionId, claimId, reason: "slot-not-owned-or-expired-at-mutation-boundary",
  });
  return { applied: false };
}

// ---------------------------------------------------------------------------
// Phase 11.2.4: Fenced resource mutations + session-state transitions
// ---------------------------------------------------------------------------

/**
 * Phase 11.2.4: Verify that the worker still holds the session execution slot.
 * Used inside fenced resource mutations (reserveResourceFenced, etc.) and
 * fenced session-state transitions (transitionSessionStateFenced).
 *
 * This is a DB read (not a mutation) — it's the authority check inside a
 * $transaction. If the slot is not held (claimId mismatch or lease expired),
 * the caller must NOT perform the mutation.
 *
 * Returns true if the slot is still held by this claim with a valid lease.
 */
export async function verifySlotClaimValid(sessionId: string, claimId: string): Promise<boolean> {
  const now = new Date();
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { executionSlotClaimId: true, executionSlotClaimExpiresAt: true },
  });
  if (!session) return false;
  if (session.executionSlotClaimId !== claimId) return false;
  if (!session.executionSlotClaimExpiresAt || session.executionSlotClaimExpiresAt < now) return false;
  return true;
}

/**
 * Phase 11.2.4: Fenced session-state transition. The transition is authorized
 * by the currently valid session execution claim — not merely preceded by a
 * checkpoint. If the slot was lost between the checkpoint and this mutation,
 * the transition does NOT happen.
 *
 * Uses a $transaction: (1) verify the slot claim, (2) perform the state
 * transition. Both are in one DB transaction — if the slot is invalid, the
 * transition is skipped.
 *
 * Returns { applied: boolean }. If false, the slot was lost.
 */
export async function fencedTransitionSessionState(
  sessionId: string,
  claimId: string,
  toState: string,
  allowedFromStates: string[],
): Promise<{ applied: boolean; reason?: string }> {
  const now = new Date();

  // Fenced updateMany: only transition if the slot is held AND the current
  // state allows the transition. This is a single atomic operation.
  const result = await db.connectivitySession.updateMany({
    where: {
      id: sessionId,
      executionSlotClaimId: claimId,
      executionSlotClaimExpiresAt: { gt: now },
      state: { in: allowedFromStates },
    },
    data: {
      state: toState,
      lastObservedAt: now,
    },
  });

  if (result.count > 0) {
    logger.info("session.fenced_transition_applied", { sessionId, claimId, toState });
    return { applied: true };
  }

  // count=0: either the slot was lost, or the state transition is illegal.
  // Distinguish for the error message.
  const slotValid = await verifySlotClaimValid(sessionId, claimId);
  const reason = !slotValid
    ? "slot-not-owned-or-expired-at-mutation-boundary"
    : `illegal-transition-to-${toState}`;
  logger.error("session.fenced_transition_rejected", { sessionId, claimId, toState, reason });
  return { applied: false, reason };
}

/**
 * Phase 11.2.5: The atomic session-lease fence primitive. This is the
 * DB-level authorization/fencing record for resource mutations.
 *
 * Inside the same transaction as the resource mutation, the FIRST operation
 * is a conditional UPDATE on the session row:
 *
 *   UPDATE ConnectivitySession
 *   SET executionSlotClaimExpiresAt = now + lease   -- renew the lease
 *   WHERE id = sessionId
 *     AND executionSlotClaimId = claimId             -- must still hold the claim
 *     AND executionSlotClaimExpiresAt > now            -- lease must still be valid
 *
 * If affectedRows != 1, the claim is invalid → ROLLBACK → no resource mutation.
 *
 * Why a conditional UPDATE (not a SELECT)?
 *   - The UPDATE takes the row lock. A concurrent reclaim/reacquire must wait,
 *     then reevaluate the predicate against the committed lease state.
 *   - A SELECT inside a transaction does NOT prevent a concurrent UPDATE from
 *     clearing the claim between the SELECT and the resource mutation (TOCTOU).
 *   - The conditional UPDATE is the durable authorization fence.
 *
 * This also renews the lease as a side effect of authorizing the mutation —
 * the worker's lease is extended while it holds the slot and performs mutations.
 * This is intentional: the worker is actively mutating, so its lease should be
 * fresh. The heartbeat is still useful for mutations that take longer than
 * SESSION_EXECUTION_SLOT_RENEWAL_INTERVAL_MS, but this per-mutation renewal
 * provides a hard DB-level guarantee.
 *
 * Returns true if the claim is valid (and the lease was renewed). The caller
 * then performs the resource mutation in the same transaction.
 */
async function withValidSessionExecutionLease<T>(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  sessionId: string,
  claimId: string,
  operation: string,
): Promise<{ authorized: boolean }> {
  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + SESSION_EXECUTION_SLOT_LEASE_MS);

  // Conditional UPDATE — takes the row lock + verifies the claim atomically.
  const result = await tx.connectivitySession.updateMany({
    where: {
      id: sessionId,
      executionSlotClaimId: claimId,
      executionSlotClaimExpiresAt: { gt: now },
    },
    data: {
      executionSlotClaimExpiresAt: newExpiresAt, // renew the lease
    },
  });

  if (result.count === 0) {
    logger.error("session.lease_fence_rejected", {
      sessionId, claimId, operation, reason: "slot-not-owned-or-expired-at-fence-boundary",
    });
    return { authorized: false };
  }

  return { authorized: true };
}

/**
 * Phase 11.2.5: Fenced resource reservation. The reservation is authorized
 * by a conditional session-row UPDATE inside the same transaction — not
 * merely a SELECT. The UPDATE takes the row lock and renews the lease.
 *
 * If the claim is invalid (UPDATE affects 0 rows), the transaction returns
 * without performing the resource mutation.
 *
 * Returns { reserved: boolean, reason?: string }.
 */
export async function fencedReserveResource(
  resourceId: string,
  sessionId: string,
  claimId: string,
  intentFence?: { intentId: string; intentVersion: number; fenceId: string },
): Promise<{ reserved: boolean; reason?: string }> {
  return await db.$transaction(async (tx) => {
    // 1. Atomic session-lease fence — conditional UPDATE (takes row lock).
    const lease = await withValidSessionExecutionLease(tx, sessionId, claimId, "reserve");
    if (!lease.authorized) {
      return { reserved: false, reason: "session-execution-slot-not-held" };
    }

    // Phase 11.4.10.1: Intent execution fence check — inside the same transaction.
    if (intentFence) {
      const { verifyIntentExecutionFence } = await import("./intent-authority");
      const intentFenceResult = await verifyIntentExecutionFence(tx, intentFence.intentId, intentFence.intentVersion, intentFence.fenceId);
      if (!intentFenceResult.valid) {
        return { reserved: false, reason: intentFenceResult.reason ?? "intent-fence-invalid" };
      }
    }

    // 2. Reserve the resource (AVAILABLE → RESERVED) — within the same transaction.
    const now = new Date();
    const result = await tx.protocolResource.updateMany({
      where: { id: resourceId, state: "AVAILABLE" },
      data: { state: "RESERVED", reservedAt: now, reservedBy: sessionId },
    });

    if (result.count === 0) {
      return { reserved: false, reason: "Resource not available or already reserved" };
    }

    logger.info("resource.fenced_reserved", { resourceId, sessionId, claimId });
    return { reserved: true };
  });
}

/**
 * Phase 11.2.5: Fenced mark-resource-in-use. Same atomic session-lease fence.
 *
 * Returns { activated: boolean, reason?: string }.
 */
export async function fencedMarkResourceInUse(
  resourceId: string,
  sessionId: string,
  claimId: string,
  intentFence?: { intentId: string; intentVersion: number; fenceId: string },
): Promise<{ activated: boolean; reason?: string }> {
  return await db.$transaction(async (tx) => {
    // 1. Atomic session-lease fence — conditional UPDATE (takes row lock).
    const lease = await withValidSessionExecutionLease(tx, sessionId, claimId, "markInUse");
    if (!lease.authorized) {
      return { activated: false, reason: "session-execution-slot-not-held" };
    }

    // Phase 11.4.10.1: Intent execution fence check — inside the same transaction.
    if (intentFence) {
      const { verifyIntentExecutionFence } = await import("./intent-authority");
      const intentFenceResult = await verifyIntentExecutionFence(tx, intentFence.intentId, intentFence.intentVersion, intentFence.fenceId);
      if (!intentFenceResult.valid) {
        return { activated: false, reason: intentFenceResult.reason ?? "intent-fence-invalid" };
      }
    }

    // 2. Mark IN_USE (RESERVED → IN_USE) — within the same transaction.
    const result = await tx.protocolResource.updateMany({
      where: { id: resourceId, reservedBy: sessionId, state: "RESERVED" },
      data: { state: "IN_USE" },
    });

    if (result.count === 0) {
      const resource = await tx.protocolResource.findUnique({
        where: { id: resourceId },
        select: { state: true, reservedBy: true },
      });
      if (!resource) return { activated: false, reason: "Resource not found" };
      if (resource.reservedBy !== sessionId) return { activated: false, reason: `Ownership mismatch: reserved by "${resource.reservedBy}"` };
      return { activated: false, reason: `Resource in state "${resource.state}", expected RESERVED` };
    }

    logger.info("resource.fenced_marked_in_use", { resourceId, sessionId, claimId });
    return { activated: true };
  });
}

/**
 * Phase 11.2.5: Fenced resource release. Same atomic session-lease fence.
 *
 * Returns { released: boolean, reason?: string }.
 */
export async function fencedReleaseResource(
  resourceId: string,
  sessionId: string,
  claimId: string,
  intentFence?: { intentId: string; intentVersion: number; fenceId: string },
): Promise<{ released: boolean; reason?: string }> {
  return await db.$transaction(async (tx) => {
    // 1. Atomic session-lease fence — conditional UPDATE (takes row lock).
    const lease = await withValidSessionExecutionLease(tx, sessionId, claimId, "release");
    if (!lease.authorized) {
      return { released: false, reason: "session-execution-slot-not-held" };
    }

    // Phase 11.4.10.1: Intent execution fence check — inside the same transaction.
    if (intentFence) {
      const { verifyIntentExecutionFence } = await import("./intent-authority");
      const intentFenceResult = await verifyIntentExecutionFence(tx, intentFence.intentId, intentFence.intentVersion, intentFence.fenceId);
      if (!intentFenceResult.valid) {
        return { released: false, reason: intentFenceResult.reason ?? "intent-fence-invalid" };
      }
    }

    // 2. Release the resource (ownership-safe) — within the same transaction.
    const result = await tx.protocolResource.updateMany({
      where: { id: resourceId, reservedBy: sessionId },
      data: { state: "AVAILABLE", reservedAt: null, reservedBy: null },
    });

    if (result.count === 0) {
      const resource = await tx.protocolResource.findUnique({
        where: { id: resourceId },
        select: { reservedBy: true, state: true },
      });
      if (!resource) return { released: false, reason: "Resource not found" };
      if (resource.reservedBy !== sessionId) return { released: false, reason: `Ownership mismatch: reserved by "${resource.reservedBy}"` };
      return { released: false, reason: `Resource in state "${resource.state}", cannot release` };
    }

    logger.info("resource.fenced_released", { resourceId, sessionId, claimId });
    return { released: true };
  });
}

// ---------------------------------------------------------------------------
// Acquire the session execution slot (DB-authoritative fenced)
// ---------------------------------------------------------------------------

/**
 * Atomically acquire the session's execution slot. Returns true if acquired,
 * false if the slot is held by another worker (with a non-expired lease).
 *
 * The acquire is a fenced updateMany with a WHERE guard:
 *   WHERE id = sessionId
 *     AND (executionSlotClaimId IS NULL  OR  executionSlotClaimExpiresAt < now)
 *   DATA: executionSlotClaimId = claimId, ...
 *
 * Two concurrent workers cannot both acquire the same session's slot — the
 * fenced updateMany guarantees exactly one succeeds (count=1), the other gets
 * count=0.
 *
 * If acquire fails (session busy), the caller should requeue the decision
 * (return it to PENDING) — NOT fail or dead-letter it. "Session busy" is a
 * legitimate "try later" condition, not a poison decision.
 */
export async function acquireSessionExecutionSlot(
  sessionId: string,
  claimId: string,
): Promise<{ acquired: boolean }> {
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + SESSION_EXECUTION_SLOT_LEASE_MS);

  const result = await db.connectivitySession.updateMany({
    where: {
      id: sessionId,
      OR: [
        { executionSlotClaimId: null },
        { executionSlotClaimExpiresAt: { lt: now } },
      ],
    },
    data: {
      executionSlotClaimId: claimId,
      executionSlotClaimedAt: now,
      executionSlotClaimExpiresAt: claimExpiresAt,
    },
  });

  if (result.count > 0) {
    logger.info("session.slot_acquired", { sessionId, claimId, claimExpiresAt });
    return { acquired: true };
  }

  // Slot is held by another worker with a non-expired lease.
  return { acquired: false };
}

// ---------------------------------------------------------------------------
// Renew the session execution slot (fenced — only claim owner renews)
// ---------------------------------------------------------------------------

/**
 * Renew (extend) the session execution slot's lease. Fenced by
 * executionSlotClaimId — only the worker holding the claim can renew it.
 *
 * Phase 11.2.1: The lease is RENEWABLE. A heartbeat in executeDecision()
 * calls this periodically while the mutation is running, extending the lease
 * so it cannot expire mid-mutation. This guarantees:
 *
 *   "A session execution slot MUST NOT become available while its owner is
 *    still performing the mutation window."
 *
 * If renewal fails (count=0), the slot was reclaimed after lease expiry
 * (the worker's heartbeats stopped for > LEASE, or the slot was forcibly
 * cleared). The caller should log a critical error — the invariant has been
 * violated and another worker may have acquired the slot. The action's own
 * fencing (idempotencyKey) and the invariant checker provide the recovery
 * boundary, but the slot guarantee is lost.
 *
 * Returns { renewed: boolean }. If false, the caller no longer holds the slot.
 */
export async function renewSessionExecutionSlot(
  sessionId: string,
  claimId: string,
): Promise<{ renewed: boolean }> {
  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + SESSION_EXECUTION_SLOT_LEASE_MS);

  const result = await db.connectivitySession.updateMany({
    where: {
      id: sessionId,
      executionSlotClaimId: claimId, // fenced — only the claim owner renews
    },
    data: {
      executionSlotClaimExpiresAt: newExpiresAt,
    },
  });

  if (result.count > 0) {
    logger.info("session.slot_renewed", { sessionId, claimId, newExpiresAt });
    return { renewed: true };
  }

  // count=0: the slot was reclaimed after lease expiry (heartbeats stopped for
  // too long) or forcibly cleared. The caller no longer holds it.
  logger.error("session.slot_renewal_failed", {
    sessionId, claimId, reason: "slot-not-held-by-this-claim-or-reclaimed",
  });
  return { renewed: false };
}

// ---------------------------------------------------------------------------
// Release the session execution slot (fenced — only claim owner releases)
// ---------------------------------------------------------------------------

/**
 * Release the session's execution slot. Fenced by executionSlotClaimId — only
 * the worker holding the claim can release it. This prevents a worker from
 * releasing a slot that was reclaimed and re-acquired by another worker
 * after lease expiry.
 *
 * Called in a finally block after action execution, regardless of outcome
 * (success/failure/reconciliation). The slot MUST be released so the next
 * decision for the session can execute.
 */
export async function releaseSessionExecutionSlot(
  sessionId: string,
  claimId: string,
): Promise<{ released: boolean }> {
  const result = await db.connectivitySession.updateMany({
    where: {
      id: sessionId,
      executionSlotClaimId: claimId, // fenced — only the claim owner releases
    },
    data: {
      executionSlotClaimId: null,
      executionSlotClaimedAt: null,
      executionSlotClaimExpiresAt: null,
    },
  });

  if (result.count > 0) {
    logger.info("session.slot_released", { sessionId, claimId });
    return { released: true };
  }

  // count=0: the slot was already released, or reclaimed by another worker
  // after lease expiry. Either way, we no longer hold it — this is safe.
  logger.warn("session.slot_release_noop", { sessionId, claimId, reason: "slot-not-held-by-this-claim" });
  return { released: false };
}

// ---------------------------------------------------------------------------
// Reclaim expired session slots (cron cleanup — crashed worker recovery)
// ---------------------------------------------------------------------------

/**
 * Reclaim session execution slots whose leases have expired (the worker died
 * mid-execution while holding the slot). Clears the claim so the next decision
 * for the session can acquire the slot.
 *
 * Unlike decision/event reclaim, there is no dead-letter for session slots —
 * the slot is just a lock, not a state machine. An expired slot is simply
 * cleared (set to null). The decision that was executing under the expired
 * slot is handled by reclaimExpiredDecisionClaims (which may requeue or
 * dead-letter it based on attemptCount).
 *
 * Called by the observe-connectivity cron alongside reclaimExpiredClaims and
 * reclaimExpiredDecisionClaims.
 */
export async function reclaimExpiredSessionSlots(): Promise<{ reclaimed: number }> {
  const now = new Date();

  // Find sessions with expired slot claims.
  const expired = await db.connectivitySession.findMany({
    where: {
      executionSlotClaimId: { not: null },
      executionSlotClaimExpiresAt: { lt: now },
    },
    select: { id: true, executionSlotClaimId: true },
    take: 100,
  });

  let reclaimed = 0;
  for (const session of expired) {
    // Fenced clear: only clear if the claim is still the expired one (a
    // concurrent worker may have already reclaimed + re-acquired it).
    const result = await db.connectivitySession.updateMany({
      where: {
        id: session.id,
        executionSlotClaimId: session.executionSlotClaimId,
        executionSlotClaimExpiresAt: { lt: now },
      },
      data: {
        executionSlotClaimId: null,
        executionSlotClaimedAt: null,
        executionSlotClaimExpiresAt: null,
      },
    });
    if (result.count > 0) {
      reclaimed++;
      logger.warn("session.slot_reclaimed_after_expiry", {
        sessionId: session.id,
        oldClaimId: session.executionSlotClaimId,
      });
    }
  }

  if (reclaimed > 0) {
    logger.info("session.slots_reclaimed", { reclaimed });
  }
  return { reclaimed };
}
