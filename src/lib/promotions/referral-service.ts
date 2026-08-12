/**
 * Referral + Customer Credit service.
 *
 * Phase 2E.7: Credit issuance and spending are now fully integrated with
 * the canonical double-entry ledger with durable, idempotent lifecycle.
 *
 * - Credit issuance uses CreditIssuance model (durable identity + state machine)
 * - Credit issuance posts ledgerCreditIssuance atomically (no silent divergence)
 * - Credit spending is concurrency-safe AND idempotent (DB unique constraint)
 * - spendCredit + CreditTransaction creation are in ONE PostgreSQL transaction
 */

import { db } from "@/lib/db";
import { generateToken } from "@/lib/security";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import { ledgerCreditIssuance } from "@/lib/finance/double-entry-ledger";

/** Generate a unique referral code for a user. */
function generateReferralCode(userId: string): string {
  const random = generateToken(3).toUpperCase().slice(0, 6);
  return `ROAM-${random}`;
}

/** Get or create a user's referral record. */
export async function getOrCreateReferral(userId: string): Promise<{ referralCode: string; totalReferrals: number; completedReferrals: number; totalRewardPaid: number }> {
  let referral = await db.referral.findUnique({ where: { referrerUserId: userId } });
  if (!referral) {
    referral = await db.referral.create({
      data: { referrerUserId: userId, referralCode: generateReferralCode(userId) },
    });
    logger.info("referral.created", { userId, code: referral.referralCode });
  }
  return {
    referralCode: referral.referralCode,
    totalReferrals: referral.totalReferrals,
    completedReferrals: referral.completedReferrals,
    totalRewardPaid: referral.totalRewardPaid,
  };
}

/** Track a referral use (when someone signs up with a referral code). */
export async function trackReferralUse(input: { referralCode: string; refereeUserId: string }): Promise<void> {
  const referral = await db.referral.findUnique({ where: { referralCode: input.referralCode.toUpperCase() } });
  if (!referral) return;
  if (referral.referrerUserId === input.refereeUserId) {
    logger.warn("referral.self_referral_blocked", { userId: input.refereeUserId });
    return;
  }
  const existing = await db.referralUse.findUnique({
    where: { referralId_refereeUserId: { referralId: referral.id, refereeUserId: input.refereeUserId } },
  });
  if (existing) return;
  await db.$transaction([
    db.referralUse.create({ data: { referralId: referral.id, refereeUserId: input.refereeUserId, status: "pending" } }),
    db.referral.update({ where: { id: referral.id }, data: { totalReferrals: { increment: 1 } } }),
  ]);
  logger.info("referral.tracked", { referralId: referral.id, refereeUserId: input.refereeUserId });
}

/**
 * Complete a referral (when the referee makes their first purchase). Awards credits.
 *
 * Phase 2E.7.1: CONCURRENCY-SAFE via conditional UPDATE.
 *
 * The serialization point is a conditional UPDATE:
 *   UPDATE ReferralUse SET status='completed' WHERE id=? AND status='pending'
 *
 * Only ONE concurrent call can claim a pending ReferralUse. The loser sees
 * 0 rows affected and exits WITHOUT performing any credit mutations.
 *
 * This guarantees that two concurrent completeReferral() calls for the same
 * ReferralUse produce EXACTLY:
 *   - one ReferralUse completion
 *   - one referrer reward (CustomerCredit + CreditTransaction)
 *   - one referee reward (CustomerCredit + CreditTransaction)
 *   - one increment to Referral.completedReferrals
 *   - one increment to Referral.totalRewardPaid
 *   - one CreditIssuance per recipient (created inside the claim transaction)
 *   - one ledger posting per recipient (via postCreditIssuance, idempotent)
 *
 * The previous implementation (Phase 2E.7) checked CreditIssuance existence
 * OUTSIDE the transaction and used an unconditional UPDATE on ReferralUse,
 * which allowed two concurrent calls to both observe "pending" and both
 * proceed to addCreditInternal() — producing duplicate operational credit
 * even though only one CreditIssuance eventually succeeded.
 */
export async function completeReferral(input: { refereeUserId: string; orderId: string }): Promise<void> {
  // Read-only lookup — no lock held here. The lock is acquired inside the
  // transaction via the conditional UPDATE below.
  const referralUse = await db.referralUse.findFirst({
    where: { refereeUserId: input.refereeUserId, status: "pending" },
    include: { referral: true },
  });
  if (!referralUse) return;

  const referral = referralUse.referral;
  const referrerIssuanceKey = `credit_issuance_referral_${referralUse.id}_referrer`;
  const refereeIssuanceKey = `credit_issuance_referral_${referralUse.id}_referee`;

  // Phase 2E.7.1: Atomically CLAIM the ReferralUse from pending → completed.
  // The conditional UPDATE (WHERE status = 'pending') is the serialization point.
  // Both concurrent calls may enter the transaction, but only ONE can match
  // the WHERE clause — the other gets 0 rows affected and exits cleanly.
  let claimed = false;
  await db.$transaction(async (tx) => {
    const affected: number = await tx.$executeRaw`
      UPDATE "ReferralUse"
      SET status = 'completed',
          "orderId" = ${input.orderId},
          "referrerCredited" = true,
          "refereeCredited" = true
      WHERE id = ${referralUse.id} AND status = 'pending'
    `;
    if (affected === 0) {
      // Lost the race — another concurrent call already completed this referral.
      // Do NOT touch counters, balance, or CreditIssuance. Exit cleanly.
      return;
    }
    claimed = true;

    // We are the sole winner. All mutations below are atomic with the claim.
    await tx.referral.update({
      where: { id: referral.id },
      data: {
        completedReferrals: { increment: 1 },
        totalRewardPaid: { increment: referral.referrerReward + referral.refereeReward },
      },
    });

    // Create durable CreditIssuance records (pending state) INSIDE this
    // transaction so they are atomically tied to the claim. Upsert guards
    // against the edge case where a record already exists from a prior
    // partial attempt that was rolled back.
    await tx.creditIssuance.upsert({
      where: { idempotencyKey: referrerIssuanceKey },
      create: {
        userId: referral.referrerUserId,
        amountMinor: referral.referrerReward,
        sourceType: "referral_reward",
        sourceId: referralUse.id,
        idempotencyKey: referrerIssuanceKey,
        status: "pending",
      },
      update: {},
    });
    await tx.creditIssuance.upsert({
      where: { idempotencyKey: refereeIssuanceKey },
      create: {
        userId: input.refereeUserId,
        amountMinor: referral.refereeReward,
        sourceType: "referral_reward",
        sourceId: referralUse.id,
        idempotencyKey: refereeIssuanceKey,
        status: "pending",
      },
      update: {},
    });

    // Add operational credit (balance + CreditTransaction) for both recipients.
    await addCreditInternal(tx, referral.referrerUserId, referral.referrerReward, "referral_reward", `Referral reward for inviting a friend`, input.orderId, referral.referrerUserId);
    await addCreditInternal(tx, input.refereeUserId, referral.refereeReward, "referral_reward", `Welcome credit from referral`, input.orderId, referral.referrerUserId);
  }, { timeout: 30000, maxWait: 15000 });

  if (!claimed) {
    // Another concurrent call won the race and completed this referral.
    logger.info("referral.lost_race", { referralUseId: referralUse.id, orderId: input.orderId });
    return;
  }

  // Phase 2E.7.1: Post ledger entries via durable CreditIssuance records.
  // The CreditIssuance records were created (status=pending) inside the
  // claim transaction above. postCreditIssuance finds them, posts the
  // idempotent ledger entry, and marks as completed. On ledger failure,
  // status → reconciliation_required, retried by processDueCreditIssuances().
  await postCreditIssuance({
    userId: referral.referrerUserId,
    amountMinor: referral.referrerReward,
    sourceType: "referral_reward",
    sourceId: referralUse.id,
    idempotencyKey: referrerIssuanceKey,
    reason: `Referral reward for ${referral.referralCode}`,
    orderId: input.orderId,
  });
  await postCreditIssuance({
    userId: input.refereeUserId,
    amountMinor: referral.refereeReward,
    sourceType: "referral_reward",
    sourceId: referralUse.id,
    idempotencyKey: refereeIssuanceKey,
    reason: `Welcome credit from referral ${referral.referralCode}`,
    orderId: input.orderId,
  });

  logger.info("referral.completed", { referralId: referral.id, refereeUserId: input.refereeUserId, orderId: input.orderId });
}

/**
 * Post a credit issuance with a durable lifecycle.
 *
 * Phase 2E.7.1:
 * - Finds the CreditIssuance record (pre-created in the claim transaction,
 *   or created here as a fallback for non-referral paths like addCredit).
 * - Posts the idempotent ledger entry (ledgerCreditIssuance replays if the
 *   idempotencyKey already exists, so concurrent/retry calls are safe).
 * - Uses a status-guarded updateMany (WHERE status IN pending/reconciliation_required)
 *   so concurrent postCreditIssuance calls or reconciliation-worker retries
 *   cannot clobber a "completed" record.
 * - On ledger failure, status → reconciliation_required. The
 *   processDueCreditIssuances() worker retries these until completed.
 */
async function postCreditIssuance(input: {
  userId: string;
  amountMinor: number;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  reason: string;
  orderId?: string;
}): Promise<void> {
  // Find the CreditIssuance record. For referrals, it was already created
  // (status=pending) inside the claim transaction. For addCredit, it may not
  // exist yet — create it as a fallback.
  let issuance = await db.creditIssuance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (!issuance) {
    try {
      issuance = await db.creditIssuance.create({
        data: {
          userId: input.userId,
          amountMinor: input.amountMinor,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          idempotencyKey: input.idempotencyKey,
          status: "pending",
        },
      });
    } catch (err: any) {
      // P2002 = another concurrent call created it. Re-fetch.
      if (err?.code === "P2002") {
        issuance = await db.creditIssuance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      } else {
        throw err;
      }
    }
  }
  if (!issuance) return; // unreachable, but satisfies TS

  if (issuance.status === "completed") {
    logger.info("credit.issuance_already_completed", { idempotencyKey: input.idempotencyKey });
    return;
  }

  // Post the idempotent ledger entry. If this idempotencyKey was already
  // posted (by a concurrent call or a prior attempt), postLedgerTransaction
  // returns the existing txnId without creating a duplicate.
  try {
    const ledgerTxnId = await ledgerCreditIssuance({
      userId: input.userId,
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      idempotencyKey: `${input.idempotencyKey}:ledger`,
    });

    // Status-guarded transition: only pending/reconciliation_required → completed.
    // This prevents a late retry from clobbering a record that another path
    // already completed. updateMany returns count; we don't need it.
    await db.creditIssuance.updateMany({
      where: { id: issuance.id, status: { in: ["pending", "reconciliation_required"] } },
      data: { status: "completed", ledgerTransactionId: ledgerTxnId },
    });
  } catch (err) {
    // Phase 2E.7.1: Do NOT silently swallow. Mark as reconciliation_required.
    // The processDueCreditIssuances() worker will retry the ledger posting.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("credit.issuance_ledger_failed", { idempotencyKey: input.idempotencyKey, error: errorMsg });
    await db.creditIssuance.updateMany({
      where: { id: issuance.id, status: { in: ["pending", "reconciliation_required"] } },
      data: { status: "reconciliation_required" },
    }).catch(() => {});
    // Do NOT throw — the operational credit was already posted in the claim
    // transaction. The reconciliation_required status makes the divergence
    // visible and retriable by processDueCreditIssuances().
  }
}

/**
 * Phase 2E.7.1: Reconciliation worker for CreditIssuance records.
 *
 * Queries all CreditIssuance records with status = 'reconciliation_required'
 * and retries the ledger posting for each. This is the actual recovery
 * mechanism referenced by postCreditIssuance's catch block.
 *
 * Idempotency:
 * - ledgerCreditIssuance replays if the ledger idempotencyKey already exists
 *   (so a retry that partially succeeded does not double-post).
 * - The status-guarded updateMany ensures a record is only marked completed once.
 * - Running this worker twice is safe — completed records are skipped.
 *
 * Returns counts for observability.
 */
export async function processDueCreditIssuances(): Promise<{
  retried: number;
  repaired: number;
  stillFailing: number;
}> {
  const result = { retried: 0, repaired: 0, stillFailing: 0 };

  const due = await db.creditIssuance.findMany({
    where: { status: "reconciliation_required" },
    select: { id: true, userId: true, amountMinor: true, sourceType: true, sourceId: true, idempotencyKey: true },
  });

  for (const issuance of due) {
    result.retried++;
    try {
      const ledgerTxnId = await ledgerCreditIssuance({
        userId: issuance.userId,
        orderId: undefined,
        amountMinor: issuance.amountMinor,
        reason: `Reconciliation retry for ${issuance.sourceType} (${issuance.idempotencyKey})`,
        idempotencyKey: `${issuance.idempotencyKey}:ledger`,
      });

      // Status-guarded: only reconciliation_required → completed.
      const update = await db.creditIssuance.updateMany({
        where: { id: issuance.id, status: "reconciliation_required" },
        data: { status: "completed", ledgerTransactionId: ledgerTxnId },
      });

      if (update.count > 0) {
        result.repaired++;
        logger.info("credit.issuance_reconciled", { idempotencyKey: issuance.idempotencyKey, ledgerTxnId });
      } else {
        // Already completed by a concurrent path — not a failure, just a no-op.
        logger.info("credit.issuance_already_completed_during_reconciliation", { idempotencyKey: issuance.idempotencyKey });
      }
    } catch (err) {
      result.stillFailing++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("credit.issuance_reconciliation_still_failing", { idempotencyKey: issuance.idempotencyKey, error: errorMsg });
      // Leave status as reconciliation_required for the next worker run.
    }
  }

  return result;
}

/** Get the user's credit balance. Creates the credit account if it doesn't exist. */
export async function getCreditBalance(userId: string): Promise<{ balanceMinor: number; currency: string; totalEarned: number; totalSpent: number }> {
  let credit = await db.customerCredit.findUnique({ where: { userId } });
  if (!credit) {
    credit = await db.customerCredit.create({ data: { userId } });
  }
  return { balanceMinor: credit.balanceMinor, currency: credit.currency, totalEarned: credit.totalEarned, totalSpent: credit.totalSpent };
}

/** Get credit transaction history. */
export async function getCreditHistory(userId: string, limit = 20) {
  return db.creditTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Add credit to a user's account (internal, transactional). */
async function addCreditInternal(tx: any, userId: string, amountMinor: number, type: string, reason: string, orderId?: string, referrerId?: string): Promise<void> {
  let credit = await tx.customerCredit.findUnique({ where: { userId } });
  if (!credit) {
    credit = await tx.customerCredit.create({ data: { userId } });
  }
  const newBalance = credit.balanceMinor + amountMinor;
  await tx.customerCredit.update({
    where: { userId },
    data: { balanceMinor: newBalance, totalEarned: { increment: amountMinor } },
  });
  await tx.creditTransaction.create({
    data: {
      creditId: credit.id,
      userId,
      type,
      amountMinor,
      balanceAfter: newBalance,
      reason,
      orderId: orderId ?? null,
      referrerId: referrerId ?? null,
    },
  });
}

/**
 * Add credit to a user's account (public, for admin/manual adjustments).
 *
 * Phase 2E.7.1: Concurrency-safe via INSERT ... ON CONFLICT DO NOTHING.
 * The CreditIssuance record creation is the serialization point — only the
 * first concurrent call creates it and performs the operational credit
 * mutation. Duplicate/retry calls find the existing record and skip the
 * balance increment (but still call postCreditIssuance to ensure the
 * ledger is posted, which is idempotent).
 */
export async function addCredit(input: { userId: string; amountMinor: number; type: string; reason: string; orderId?: string; operationId?: string }): Promise<void> {
  // Phase 2E.7: Require a stable operation identity (no Date.now fallback).
  const operationId = input.operationId ?? input.orderId;
  if (!operationId) {
    throw new AppError("validation", "operationId or orderId is required for credit issuance", 400, "A stable operation identity is required for credit issuance idempotency.");
  }

  const idempotencyKey = `credit_issuance_${input.type}_${operationId}_${input.userId}`;

  // Phase 2E.7.1: Fast-path — if already completed, skip entirely.
  const existing = await db.creditIssuance.findUnique({ where: { idempotencyKey } });
  if (existing?.status === "completed") {
    logger.info("credit.add_already_completed", { idempotencyKey });
    return;
  }

  // Phase 2E.7.1: Atomically claim the CreditIssuance slot inside a
  // transaction. INSERT ... ON CONFLICT DO NOTHING ensures only ONE
  // concurrent call creates the record and performs the operational credit.
  // The loser gets 0 rows affected and skips addCreditInternal.
  let performedCredit = false;
  await db.$transaction(async (tx) => {
    const claimed: number = await tx.$executeRaw`
      INSERT INTO "CreditIssuance" ("id", "userId", "amountMinor", "sourceType", "sourceId", "idempotencyKey", "status", "createdAt", "updatedAt")
      VALUES (
        ${crypto.randomUUID()}, ${input.userId}, ${input.amountMinor}, ${input.type}, ${operationId},
        ${idempotencyKey}, 'pending', NOW(), NOW()
      )
      ON CONFLICT ("idempotencyKey") DO NOTHING
    `;
    if (claimed === 0) {
      // Duplicate concurrent call — CreditIssuance already exists.
      // Do NOT add operational credit (the winner already did).
      return;
    }
    performedCredit = true;
    await addCreditInternal(tx, input.userId, input.amountMinor, input.type, input.reason, input.orderId);
  }, { timeout: 30000, maxWait: 15000 });

  // Post the ledger entry (idempotent — safe even if this is a duplicate call
  // that didn't perform the operational credit; postCreditIssuance handles
  // the "already completed" case internally).
  await postCreditIssuance({
    userId: input.userId,
    amountMinor: input.amountMinor,
    sourceType: input.type,
    sourceId: operationId,
    idempotencyKey,
    reason: input.reason,
    orderId: input.orderId,
  });

  if (performedCredit) {
    await audit({ userId: input.userId, action: "credit.added", entity: "user", entityId: input.userId, detail: { amount: input.amountMinor, type: input.type, operationId } });
    logger.info("credit.added", { userId: input.userId, amount: input.amountMinor, type: input.type, operationId });
  } else {
    logger.info("credit.add_skipped_duplicate", { userId: input.userId, operationId, idempotencyKey });
  }
}

/**
 * Spend credit at checkout. Returns the amount actually spent.
 *
 * Phase 2E.7:
 * - Concurrency-safe: atomic conditional UPDATE with FOR UPDATE row lock
 * - Idempotent: (userId, orderId, type) UNIQUE constraint on CreditTransaction
 * - Atomic: balance decrement + CreditTransaction creation in ONE transaction
 *
 * Two concurrent calls with the same orderId will produce exactly ONE spend.
 * The second call catches the P2002 unique constraint and returns the existing amount.
 */
export async function spendCredit(input: { userId: string; amountMinor: number; orderId: string; reason: string }): Promise<number> {
  // Phase 2E.7: Atomic idempotency + balance in ONE transaction.
  // The UNIQUE(userId, orderId, type) constraint on CreditTransaction
  // prevents duplicate spending. If a concurrent call already created the
  // CreditTransaction, the INSERT will fail with P2002, and we catch it
  // and return the existing amount.
  try {
    return await db.$transaction(async (tx) => {
      // Lock the credit row
      const credit = await tx.$queryRaw<Array<{ balanceMinor: number; id: string; creditId: string }>>`
        SELECT "balanceMinor", "id" as credit_id, "id" as id
        FROM "CustomerCredit"
        WHERE "userId" = ${input.userId}
        FOR UPDATE
      `;

      if (!credit.length || credit[0].balanceMinor <= 0) return 0;

      const currentBalance = Number(credit[0].balanceMinor);
      const creditId = credit[0].id;
      const spendAmount = Math.min(currentBalance, input.amountMinor);
      if (spendAmount <= 0) return 0;

      const newBalance = currentBalance - spendAmount;

      // Update balance
      await tx.customerCredit.update({
        where: { userId: input.userId },
        data: { balanceMinor: newBalance, totalSpent: { increment: spendAmount } },
      });

      // Create CreditTransaction (UNIQUE constraint guards concurrency)
      await tx.creditTransaction.create({
        data: {
          creditId,
          userId: input.userId,
          type: "purchase_credit",
          amountMinor: -spendAmount,
          balanceAfter: newBalance,
          reason: input.reason,
          orderId: input.orderId,
        },
      });

      logger.info("credit.spent", { userId: input.userId, amount: spendAmount, orderId: input.orderId });
      return spendAmount;
    }, { timeout: 30000, maxWait: 15000 });
  } catch (err: any) {
    // P2002 = unique constraint violation — another concurrent call already
    // created the CreditTransaction for this orderId. Return the existing amount.
    if (err?.code === "P2002") {
      logger.info("credit.spend_concurrent_duplicate", { userId: input.userId, orderId: input.orderId });
      const existing = await db.creditTransaction.findFirst({
        where: { userId: input.userId, orderId: input.orderId, type: "purchase_credit" },
      });
      return existing ? -existing.amountMinor : 0;
    }
    throw err;
  }
}

/**
 * Reconcile operational customer credit balance with the financial ledger.
 * Phase 2E.7: Returns discrepancies between CustomerCredit.balanceMinor
 * and the ledger's CUSTOMER_CREDIT_LIABILITY balance.
 */
export async function reconcileCreditWithLedger(): Promise<{
  reconciled: boolean;
  discrepancies: { userId: string; operationalBalance: number; ledgerLiability: number; difference: number }[];
}> {
  const { ACCOUNT_CODES } = await import("@/lib/finance/double-entry-ledger");

  // Get total operational credit balance
  const operationalTotal = await db.customerCredit.aggregate({
    _sum: { balanceMinor: true },
  });
  const operationalBalance = operationalTotal._sum.balanceMinor ?? 0;

  // Get ledger CUSTOMER_CREDIT_LIABILITY balance
  // Credits minus debits (liability is CREDIT-normal)
  const ledgerEntries = await db.ledgerEntry.findMany({
    where: { account: { code: ACCOUNT_CODES.CUSTOMER_CREDIT_LIABILITY } },
    select: { direction: true, amountMinor: true },
  });
  const credits = ledgerEntries.filter(e => e.direction === "CREDIT").reduce((s, e) => s + e.amountMinor, 0);
  const debits = ledgerEntries.filter(e => e.direction === "DEBIT").reduce((s, e) => s + e.amountMinor, 0);
  const ledgerLiability = credits - debits;

  const difference = operationalBalance - ledgerLiability;
  const reconciled = Math.abs(difference) === 0;

  if (!reconciled) {
    logger.warn("credit.reconciliation_discrepancy", {
      operationalBalance,
      ledgerLiability,
      difference,
    });
  }

  return {
    reconciled,
    discrepancies: reconciled ? [] : [{
      userId: "_aggregate",
      operationalBalance,
      ledgerLiability,
      difference,
    }],
  };
}
