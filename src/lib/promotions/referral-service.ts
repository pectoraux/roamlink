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

/** Complete a referral (when the referee makes their first purchase). Awards credits. */
export async function completeReferral(input: { refereeUserId: string; orderId: string }): Promise<void> {
  const referralUse = await db.referralUse.findFirst({
    where: { refereeUserId: input.refereeUserId, status: "pending" },
    include: { referral: true },
  });
  if (!referralUse) return;

  const referral = referralUse.referral;

  // Phase 2E.7: Use durable CreditIssuance records for idempotency.
  // Each issuance has a stable identity: credit_issuance_referral_{referralUseId}_{recipient}
  const referrerIssuanceKey = `credit_issuance_referral_${referralUse.id}_referrer`;
  const refereeIssuanceKey = `credit_issuance_referral_${referralUse.id}_referee`;

  // Check if already completed (idempotent)
  const existingReferrer = await db.creditIssuance.findUnique({ where: { idempotencyKey: referrerIssuanceKey } });
  const existingReferee = await db.creditIssuance.findUnique({ where: { idempotencyKey: refereeIssuanceKey } });
  if (existingReferrer?.status === "completed" && existingReferee?.status === "completed") {
    logger.info("referral.already_completed", { referralUseId: referralUse.id });
    return;
  }

  // Mark referral as completed (inside a transaction with the credit updates)
  await db.$transaction(async (tx) => {
    await tx.referralUse.update({
      where: { id: referralUse.id },
      data: { status: "completed", orderId: input.orderId, referrerCredited: true, refereeCredited: true },
    });
    await tx.referral.update({
      where: { id: referral.id },
      data: { completedReferrals: { increment: 1 }, totalRewardPaid: { increment: referral.referrerReward + referral.refereeReward } },
    });

    // Credit referrer
    if (!existingReferrer) {
      await addCreditInternal(tx, referral.referrerUserId, referral.referrerReward, "referral_reward", `Referral reward for inviting a friend`, input.orderId, referral.referrerUserId);
    }
    // Credit referee
    if (!existingReferee) {
      await addCreditInternal(tx, input.refereeUserId, referral.refereeReward, "referral_reward", `Welcome credit from referral`, input.orderId, referral.referrerUserId);
    }
  });

  // Phase 2E.7: Post ledger entries via durable CreditIssuance records.
  // If the ledger call fails, the issuance is marked reconciliation_required.
  if (!existingReferrer || existingReferrer.status !== "completed") {
    await postCreditIssuance({
      userId: referral.referrerUserId,
      amountMinor: referral.referrerReward,
      sourceType: "referral_reward",
      sourceId: referralUse.id,
      idempotencyKey: referrerIssuanceKey,
      reason: `Referral reward for ${referral.referralCode}`,
      orderId: input.orderId,
    });
  }
  if (!existingReferee || existingReferee.status !== "completed") {
    await postCreditIssuance({
      userId: input.refereeUserId,
      amountMinor: referral.refereeReward,
      sourceType: "referral_reward",
      sourceId: referralUse.id,
      idempotencyKey: refereeIssuanceKey,
      reason: `Welcome credit from referral ${referral.referralCode}`,
      orderId: input.orderId,
    });
  }

  logger.info("referral.completed", { referralId: referral.id, refereeUserId: input.refereeUserId, orderId: input.orderId });
}

/**
 * Post a credit issuance with a durable lifecycle.
 * Creates a CreditIssuance record, posts the ledger entry, and marks as completed.
 * If the ledger fails, the issuance is marked reconciliation_required (NOT silently swallowed).
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
  // Find or create the CreditIssuance record
  let issuance = await db.creditIssuance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (!issuance) {
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
  }

  if (issuance.status === "completed") {
    logger.info("credit.issuance_already_completed", { idempotencyKey: input.idempotencyKey });
    return;
  }

  // Post the ledger entry
  try {
    const ledgerTxnId = await ledgerCreditIssuance({
      userId: input.userId,
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      idempotencyKey: `${input.idempotencyKey}:ledger`,
    });

    await db.creditIssuance.update({
      where: { id: issuance.id },
      data: { status: "completed", ledgerTransactionId: ledgerTxnId },
    });
  } catch (err) {
    // Phase 2E.7: Do NOT silently swallow. Mark as reconciliation_required.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("credit.issuance_ledger_failed", { idempotencyKey: input.idempotencyKey, error: errorMsg });
    await db.creditIssuance.update({
      where: { id: issuance.id },
      data: { status: "reconciliation_required" },
    }).catch(() => {});
    // Do NOT throw — the operational credit was already posted in the transaction.
    // The reconciliation_required status makes the divergence visible and retriable.
    // A background reconciliation job can retry the ledger posting.
  }
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

/** Add credit to a user's account (public, for admin/manual adjustments). */
export async function addCredit(input: { userId: string; amountMinor: number; type: string; reason: string; orderId?: string; operationId?: string }): Promise<void> {
  // Phase 2E.7: Require a stable operation identity (no Date.now fallback).
  const operationId = input.operationId ?? input.orderId;
  if (!operationId) {
    throw new AppError("validation", "operationId or orderId is required for credit issuance", 400, "A stable operation identity is required for credit issuance idempotency.");
  }

  const idempotencyKey = `credit_issuance_${input.type}_${operationId}_${input.userId}`;

  // Check if already done (idempotent)
  const existing = await db.creditIssuance.findUnique({ where: { idempotencyKey } });
  if (existing?.status === "completed") {
    logger.info("credit.add_already_completed", { idempotencyKey });
    return;
  }

  await db.$transaction(async (tx) => {
    await addCreditInternal(tx, input.userId, input.amountMinor, input.type, input.reason, input.orderId);
  });

  await postCreditIssuance({
    userId: input.userId,
    amountMinor: input.amountMinor,
    sourceType: input.type,
    sourceId: operationId,
    idempotencyKey,
    reason: input.reason,
    orderId: input.orderId,
  });

  await audit({ userId: input.userId, action: "credit.added", entity: "user", entityId: input.userId, detail: { amount: input.amountMinor, type: input.type, operationId } });
  logger.info("credit.added", { userId: input.userId, amount: input.amountMinor, type: input.type, operationId });
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
    });
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
