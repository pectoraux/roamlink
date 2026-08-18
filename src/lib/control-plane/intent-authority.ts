/**
 * Control Plane — Intent Authority Fence (Phase 11.4.9)
 *
 * A PostgreSQL-authoritative intent authority fence at the mutation boundary.
 * Analogous to the session execution slot fence (Phase 11.2.5).
 *
 * The architectural rule:
 *   "Intent authority must be bound to the execution claim at the mutation boundary."
 *
 * Phase 11.4.9 (PostgreSQL-authoritative):
 * The previous implementation used a SELECT inside a transaction. On PostgreSQL,
 * a normal SELECT does NOT prevent another transaction from updating the intent
 * row. This is the same TOCTOU we eliminated for session slots in 11.2.5.
 *
 * The fix: use a conditional UPDATE on the intent row (not a SELECT) as the
 * first operation inside the transaction. The UPDATE takes the row lock and
 * evaluates the authority predicate atomically:
 *
 *   UPDATE connectivity_intent_record
 *   SET fenceVersion = fenceVersion + 1   -- harmless bump, takes row lock
 *   WHERE intentId = ?
 *     AND version = ?                      -- exact version attached to decision
 *     AND status = 'ACTIVE'
 *     AND (expiresAt IS NULL OR expiresAt > now)
 *
 * If affectedRows != 1, the intent is no longer authoritative (superseded,
 * expired, or not found). The decision is transitioned to SKIPPED (fenced by
 * executionClaimId). No resource mutation occurs.
 *
 * If affectedRows = 1, the intent was authoritative at the mutation boundary.
 * The row lock prevents a concurrent supersede/expire from changing the intent
 * until the transaction commits. The caller proceeds to the action.
 *
 * The fence binds to the EXACT intent version attached to the decision — not
 * "whatever the current intent happens to be." This protects:
 *   v1 decision → v2 supersedes v1 → the v1 decision's fence fails
 *   (status is SUPERSEDED, not ACTIVE).
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const DECISION_EXECUTING = "EXECUTING";
const DECISION_SKIPPED = "SKIPPED";

/**
 * Test-only hook for deterministic post-check race testing.
 * When set, the hook is called AFTER the post-claim authority check but BEFORE
 * the mutation-boundary fence. The test can use this to expire/supersede the
 * intent between the two checks, proving the mutation-boundary fence catches
 * the race.
 */
type IntentExpiryHook = (intentId: string, intentVersion: number) => void;
let intentExpiryHook: IntentExpiryHook | null = null;

export function setIntentExpiryHook(fn: IntentExpiryHook): void {
  intentExpiryHook = fn;
}

export function clearIntentExpiryHook(): void {
  intentExpiryHook = null;
}

/**
 * Verify intent authority at the mutation boundary using a conditional UPDATE
 * on the intent row. Returns { authorized } indicating whether the intent was
 * ACTIVE and unexpired at the mutation boundary.
 *
 * If unauthorized, transitions the decision to SKIPPED (fenced by claimId)
 * inside the same transaction. The caller must NOT proceed to the action.
 *
 * This is the DB-level intent authority fence — a conditional UPDATE, not a
 * preflight SELECT.
 */
export async function verifyIntentAuthorityAtBoundary(
  decisionId: string,
  executionClaimId: string,
  intentId: string,
  intentVersion: number,
): Promise<{ authorized: boolean; reason?: string }> {
  // Phase 11.4.10: Test-only hook for deterministic race testing.
  // The test can expire/supersede the intent here — between the post-claim
  // check and the mutation-boundary fence — to prove the fence catches it.
  // The hook is AWAITED so its DB update commits before the fence's
  // conditional UPDATE runs. This makes the race deterministic.
  if (intentExpiryHook) {
    await intentExpiryHook(intentId, intentVersion);
  }

  return await db.$transaction(async (tx) => {
    const now = new Date();

    // 1. Conditional UPDATE on the intent row — takes the row lock and
    //    evaluates the authority predicate atomically.
    //    WHERE: exact intentId + version (bound to the decision)
    //           status = ACTIVE
    //           (expiresAt IS NULL OR expiresAt > now)
    //    DATA: fenceVersion = fenceVersion + 1 (harmless bump, establishes lock)
    const fenceResult = await tx.connectivityIntentRecord.updateMany({
      where: {
        intentId,
        version: intentVersion,
        status: "ACTIVE",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      data: {
        fenceVersion: { increment: 1 },
      },
    });

    // 2. If the conditional UPDATE affected 0 rows, the intent is no longer
    //    authoritative (superseded, expired, or not found).
    if (fenceResult.count === 0) {
      // Determine the reason for a better error message.
      const intent = await tx.connectivityIntentRecord.findUnique({
        where: { intentId_version: { intentId, version: intentVersion } },
        select: { status: true, expiresAt: true },
      });

      let reason: string;
      if (!intent) {
        reason = "intent-record-not-found";
      } else if (intent.status !== "ACTIVE") {
        reason = `intent-status-${intent.status}`;
      } else if (intent.expiresAt && intent.expiresAt <= now) {
        reason = "intent-expired";
      } else {
        reason = "intent-fence-rejected";
      }

      // 3. Fenced SKIP transition — only the claim owner can SKIP.
      //    WHERE executionState = EXECUTING AND executionClaimId = claimId.
      const skipResult = await tx.connectivityDecision.updateMany({
        where: {
          id: decisionId,
          executionState: DECISION_EXECUTING,
          executionClaimId: executionClaimId,
        },
        data: {
          executionState: DECISION_SKIPPED,
          executedAt: now,
        },
      });

      if (skipResult.count > 0) {
        logger.warn("decision.intent_authority_fence_rejected", {
          decisionId, executionClaimId, intentId, intentVersion, reason,
        });
      }

      return { authorized: false, reason };
    }

    // 4. Authorized — the conditional UPDATE affected 1 row, meaning the
    //    intent was ACTIVE and unexpired at the mutation boundary. The row
    //    lock prevents a concurrent supersede/expire from changing it until
    //    the transaction commits. The caller proceeds to the action.
    logger.info("intent.authority_fence_acquired", {
      intentId, intentVersion, decisionId, fenceVersion: fenceResult.count,
    });
    return { authorized: true };
  });
}
