/**
 * Control Plane — Intent Authority Fence (Phase 11.4.6)
 *
 * A DB-authoritative intent authority fence at the mutation boundary.
 * Analogous to the session execution slot fence (Phase 11.2.5).
 *
 * The architectural rule:
 *   "Intent authority must be bound to the execution claim at the mutation boundary."
 *
 * This prevents the TOCTOU:
 *   intent ACTIVE at post-claim check
 *       → intent expires/superseded
 *       → session slot acquired
 *       → resource mutation
 *
 * The fence is a $transaction that:
 *   1. Reads the intent record (status + expiresAt) — inside the transaction,
 *      so a concurrent expireStaleIntents/supersedeIntent cannot change it
 *      mid-transaction (SQLite serializes writes within a transaction).
 *   2. Verifies status = ACTIVE AND (expiresAt IS NULL OR expiresAt > now).
 *   3. If invalid → fenced SKIP transition (WHERE executionState = EXECUTING
 *      AND executionClaimId = claimId). Returns { authorized: false }.
 *   4. If valid → returns { authorized: true }. The caller proceeds to the
 *      session slot + action execution.
 *
 * The intent record is NOT mutated (no lease renewal) — intent authority is
 * a read-only verification, not a mutation. The decision's executionClaimId
 * is the ownership predicate.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const DECISION_EXECUTING = "EXECUTING";
const DECISION_SKIPPED = "SKIPPED";

/**
 * Verify intent authority at the mutation boundary. Returns { authorized }
 * indicating whether the intent is still ACTIVE and unexpired.
 *
 * If unauthorized, transitions the decision to SKIPPED (fenced by claimId)
 * inside the same transaction. The caller must NOT proceed to the session
 * slot + action execution if { authorized: false }.
 *
 * This is the DB-level intent authority fence — not a preflight read.
 */
export async function verifyIntentAuthorityAtBoundary(
  decisionId: string,
  executionClaimId: string,
  intentId: string,
  intentVersion: number,
): Promise<{ authorized: boolean; reason?: string }> {
  return await db.$transaction(async (tx) => {
    const now = new Date();

    // 1. Read the intent record inside the transaction. In SQLite, all writes
    //    within a transaction are serialized, so a concurrent
    //    expireStaleIntents/supersedeIntent cannot change the intent's status
    //    between this read and the subsequent decision transition.
    const intent = await tx.connectivityIntentRecord.findUnique({
      where: { intentId_version: { intentId, version: intentVersion } },
      select: { status: true, expiresAt: true },
    });

    // 2. Verify authority: status = ACTIVE AND (no expiry OR not expired).
    let authorized = true;
    let reason: string | undefined;

    if (!intent) {
      authorized = false;
      reason = "intent-record-not-found";
    } else if (intent.status !== "ACTIVE") {
      authorized = false;
      reason = `intent-status-${intent.status}`;
    } else if (intent.expiresAt && intent.expiresAt <= now) {
      authorized = false;
      reason = "intent-expired";
    }

    if (!authorized) {
      // 3. Fenced SKIP transition — only the claim owner can SKIP.
      //    WHERE executionState = EXECUTING AND executionClaimId = claimId.
      const skipResult = await tx.connectivityDecision.updateMany({
        where: {
          id: decisionId,
          executionState: DECISION_EXECUTING,
          executionClaimId: executionClaimId, // fenced — only the claim owner
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
      // If count=0: another worker changed the state (shouldn't happen — we
      // own the claim). Either way, we return unauthorized.

      return { authorized: false, reason };
    }

    // 4. Authorized — the caller proceeds to the session slot + action.
    return { authorized: true };
  });
}
