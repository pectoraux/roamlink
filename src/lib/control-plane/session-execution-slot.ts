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
