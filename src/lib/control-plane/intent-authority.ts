/**
 * Control Plane — Intent Authority Fence (Phase 11.4.10.1)
 *
 * A durable execution fence that PERSISTS through the mutation window.
 * Analogous to the session execution slot fence (Phase 11.2.5).
 *
 * The architectural rule:
 *   "Intent authority must be bound to the execution claim at the mutation boundary."
 *
 * Phase 11.4.9 used a conditional UPDATE that committed immediately — the
 * fence was released before the actual connectivity mutation. Phase 11.4.10.1
 * fixes this: the fence PERSISTS (executionFenceId + executionFenceExpiresAt
 * on the intent record) and is checked at EVERY fenced resource mutation.
 *
 * The fence lifecycle:
 *   1. verifyIntentAuthorityAtBoundary: conditional UPDATE on the intent row
 *      to SET executionFenceId + executionFenceExpiresAt (takes row lock +
 *      evaluates authority predicate). The fence PERSISTS after commit.
 *   2. Each fenced resource mutation (fencedReserveResource, fencedMarkResourceInUse,
 *      fencedReleaseResource) calls verifyIntentExecutionFence inside its
 *      $transaction — a conditional UPDATE that verifies the fence is still
 *      held by this claim AND the intent is still ACTIVE AND unexpired.
 *   3. If the intent is superseded/expired between the fence claim and the
 *      mutation, the fence's executionFenceId is still set (the supersede
 *      doesn't clear it), BUT the intent's status is no longer ACTIVE →
 *      the conditional UPDATE affects 0 rows → mutation rejected.
 *   4. The fence is cleared (executionFenceId = null) when the decision
 *      completes (executeDecision's finally block) or when it expires.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const DECISION_EXECUTING = "EXECUTING";
const DECISION_SKIPPED = "SKIPPED";

/**
 * Duration the intent execution fence is valid. Must cover the full mutation
 * window (reserve → activate → verify → release). Matches the session slot
 * lease + decision execution lease (5 min).
 */
const INTENT_EXECUTION_FENCE_LEASE_MS = 5 * 60_000;

/**
 * Test-only hook for deterministic race testing.
 * When set, the hook is called AFTER the post-claim authority check but BEFORE
 * the mutation-boundary fence. The test can use this to expire/supersede the
 * intent between the two checks, proving the fence catches the race.
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
 * Phase 11.4.10.1: Claim a durable intent execution fence.
 *
 * Conditional UPDATE on the intent row:
 *   SET executionFenceId = fenceId, executionFenceExpiresAt = now + LEASE
 *   WHERE intentId = ? AND version = ?
 *     AND status = 'ACTIVE'
 *     AND (expiresAt IS NULL OR expiresAt > now)
 *
 * If affectedRows = 1: the intent was ACTIVE + unexpired. The fence is set
 * and PERSISTS after commit. The fenceId ties the intent to this specific
 * decision execution.
 *
 * If affectedRows = 0: the intent is no longer authoritative. Fenced SKIP
 * transition. Returns { authorized: false }.
 *
 * The fence is cleared by clearIntentExecutionFence when the decision completes.
 */
export async function verifyIntentAuthorityAtBoundary(
  decisionId: string,
  executionClaimId: string,
  intentId: string,
  intentVersion: number,
): Promise<{ authorized: boolean; reason?: string; fenceId?: string }> {
  // Phase 11.4.10: Test-only hook for deterministic race testing.
  if (intentExpiryHook) {
    await intentExpiryHook(intentId, intentVersion);
  }

  const now = new Date();
  const fenceId = `intent-fence-${decisionId}-${now.getTime()}`;
  const fenceExpiresAt = new Date(now.getTime() + INTENT_EXECUTION_FENCE_LEASE_MS);

  return await db.$transaction(async (tx) => {
    // 1. Conditional UPDATE — takes the row lock + evaluates authority.
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
        executionFenceId: fenceId,
        executionFenceExpiresAt: fenceExpiresAt,
      },
    });

    if (fenceResult.count === 0) {
      // Determine the reason.
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

      // Fenced SKIP transition.
      const skipResult = await tx.connectivityDecision.updateMany({
        where: {
          id: decisionId,
          executionState: DECISION_EXECUTING,
          executionClaimId,
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

    // 2. Authorized — the fence is set and PERSISTS after commit.
    logger.info("intent.authority_fence_acquired", {
      intentId, intentVersion, decisionId, fenceId, fenceExpiresAt,
    });
    return { authorized: true, fenceId };
  });
}

/**
 * Phase 11.4.10.1: Verify the intent execution fence at a resource mutation boundary.
 *
 * Called inside each fenced resource mutation's $transaction (fencedReserveResource,
 * fencedMarkResourceInUse, fencedReleaseResource). A conditional UPDATE that
 * verifies the fence is still held by this claim AND the intent is still ACTIVE:
 *
 *   UPDATE connectivity_intent_record
 *   SET fenceVersion = fenceVersion + 1   -- harmless bump, takes row lock
 *   WHERE intentId = ?
 *     AND version = ?
 *     AND status = 'ACTIVE'                -- must still be ACTIVE (not superseded)
 *     AND (expiresAt IS NULL OR expiresAt > now)
 *     AND executionFenceId = ?            -- must be our fence
 *     AND executionFenceExpiresAt > now    -- fence must not have expired
 *
 * If affectedRows = 0: the intent was superseded/expired/fence-lost between
 * the fence claim and this mutation. Returns { valid: false }.
 *
 * This is the same pattern as withValidSessionExecutionLease (11.2.5):
 * a conditional UPDATE inside the mutation's $transaction, not a SELECT.
 */
export async function verifyIntentExecutionFence(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  intentId: string,
  intentVersion: number,
  fenceId: string,
): Promise<{ valid: boolean; reason?: string }> {
  const now = new Date();

  const result = await tx.connectivityIntentRecord.updateMany({
    where: {
      intentId,
      version: intentVersion,
      status: "ACTIVE",
      executionFenceId: fenceId,
      executionFenceExpiresAt: { gt: now },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    data: {
      fenceVersion: { increment: 1 },
    },
  });

  if (result.count === 0) {
    // The fence is no longer valid — intent was superseded/expired, or the
    // fence was cleared/expired. The resource mutation MUST NOT proceed.
    logger.error("intent.execution_fence_invalid_at_mutation", {
      intentId, intentVersion, fenceId,
    });
    return { valid: false, reason: "intent-fence-invalid-at-mutation-boundary" };
  }

  return { valid: true };
}

/**
 * Phase 11.4.10.1: Clear the intent execution fence.
 *
 * Called in executeDecision's finally block (or when the decision completes).
 * Clears executionFenceId + executionFenceExpiresAt so the intent can be
 * claimed by a future decision execution.
 */
export async function clearIntentExecutionFence(
  intentId: string,
  intentVersion: number,
  fenceId: string,
): Promise<void> {
  await db.connectivityIntentRecord.updateMany({
    where: {
      intentId,
      version: intentVersion,
      executionFenceId: fenceId,
    },
    data: {
      executionFenceId: null,
      executionFenceExpiresAt: null,
    },
  }).catch(() => {});
  logger.info("intent.execution_fence_cleared", { intentId, intentVersion, fenceId });
}
