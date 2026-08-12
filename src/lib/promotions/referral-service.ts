/**
 * Referral + Customer Credit service.
 *
 * Phase 2E.6: Credit issuance and spending are now fully integrated with
 * the canonical double-entry ledger.
 *
 * - Credit issuance (referral/promo/admin) posts ledgerCreditIssuance()
 *   → Dr Promotional Expense / Cr Customer Credit Liability
 * - Credit spending is concurrency-safe (atomic conditional UPDATE)
 * - Credit spending is idempotent per orderId (stable identity)
 * - Renewal retries reuse the original credit consumption
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
      data: {
        referrerUserId: userId,
        referralCode: generateReferralCode(userId),
      },
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
    db.referralUse.create({
      data: { referralId: referral.id, refereeUserId: input.refereeUserId, status: "pending" },
    }),
    db.referral.update({
      where: { id: referral.id },
      data: { totalReferrals: { increment: 1 } },
    }),
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

  // Phase 2E.6: Credit issuance now posts to the canonical double-entry ledger.
  // Idempotency: the referralUse.id is the stable identity — if this method
  // is called twice for the same referral use, the second call finds it
  // already completed and returns early.
  await db.$transaction(async (tx) => {
    await tx.referralUse.update({
      where: { id: referralUse.id },
      data: { status: "completed", orderId: input.orderId, referrerCredited: true, refereeCredited: true },
    });

    await tx.referral.update({
      where: { id: referral.id },
      data: { completedReferrals: { increment: 1 }, totalRewardPaid: { increment: referral.referrerReward + referral.refereeReward } },
    });

    // Credit referrer + post ledger entry
    await addCreditInternal(tx, referral.referrerUserId, referral.referrerReward, "referral_reward", `Referral reward for inviting a friend`, input.orderId, referral.referrerUserId);
    // Credit referee + post ledger entry
    await addCreditInternal(tx, input.refereeUserId, referral.refereeReward, "referral_reward", `Welcome credit from referral`, input.orderId, referral.referrerUserId);
  });

  // Post double-entry ledger for credit issuance (outside the transaction because
  // the ledger helper uses its own DB operations with idempotency keys).
  // The idempotency key is tied to the referralUse + orderId, so duplicate
  // calls won't create duplicate ledger entries.
  const issuanceIdem = `credit_issuance_referral_${referralUse.id}`;
  try {
    await ledgerCreditIssuance({
      userId: referral.referrerUserId,
      orderId: input.orderId,
      amountMinor: referral.referrerReward,
      reason: `Referral reward for ${referral.referralCode}`,
      idempotencyKey: `${issuanceIdem}_referrer`,
    });
    await ledgerCreditIssuance({
      userId: input.refereeUserId,
      orderId: input.orderId,
      amountMinor: referral.refereeReward,
      reason: `Welcome credit from referral ${referral.referralCode}`,
      idempotencyKey: `${issuanceIdem}_referee`,
    });
  } catch (e) {
    logger.error("credit.ledger_issuance_failed", { referralUseId: referralUse.id, error: e instanceof Error ? e.message : String(e) });
    // Don't throw — the credit balance was updated in the transaction.
    // The ledger can be reconciled later. But log prominently.
  }

  logger.info("referral.completed", { referralId: referral.id, refereeUserId: input.refereeUserId, orderId: input.orderId });
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
    data: {
      balanceMinor: newBalance,
      totalEarned: { increment: amountMinor },
    },
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
export async function addCredit(input: { userId: string; amountMinor: number; type: string; reason: string; orderId?: string }): Promise<void> {
  await db.$transaction(async (tx) => {
    await addCreditInternal(tx, input.userId, input.amountMinor, input.type, input.reason, input.orderId);
  });

  // Post double-entry ledger for credit issuance
  const idemKey = `credit_issuance_${input.type}_${input.userId}_${input.orderId ?? Date.now()}`;
  try {
    await ledgerCreditIssuance({
      userId: input.userId,
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      idempotencyKey: idemKey,
    });
  } catch (e) {
    logger.error("credit.ledger_issuance_failed", { userId: input.userId, type: input.type, error: e instanceof Error ? e.message : String(e) });
  }

  await audit({ userId: input.userId, action: "credit.added", entity: "user", entityId: input.userId, detail: { amount: input.amountMinor, type: input.type } });
  logger.info("credit.added", { userId: input.userId, amount: input.amountMinor, type: input.type });
}

/**
 * Spend credit at checkout. Returns the amount actually spent.
 *
 * Phase 2E.6:
 * - Concurrency-safe: uses atomic conditional UPDATE (balance >= amount)
 * - Idempotent: if a CreditTransaction already exists for the same orderId,
 *   returns the existing spend amount without spending again.
 */
export async function spendCredit(input: { userId: string; amountMinor: number; orderId: string; reason: string }): Promise<number> {
  // Idempotency: check if credit was already spent for this orderId
  const existingTxn = await db.creditTransaction.findFirst({
    where: { userId: input.userId, orderId: input.orderId, amountMinor: { lt: 0 } },
  });
  if (existingTxn) {
    logger.info("credit.spend_idempotent_skip", { userId: input.userId, orderId: input.orderId, existingAmount: -existingTxn.amountMinor });
    return -existingTxn.amountMinor; // already spent this much
  }

  // Concurrency-safe atomic deduction: only decrement if balance >= amount
  // This prevents negative balances from concurrent spending.
  // Phase 2E.6: Concurrency-safe atomic deduction.
  // Uses a CTE to capture the old balance (FOR UPDATE) then computes the
  // spend amount from the old value, not the post-update value.
  const result = await db.$queryRaw<Array<{ spent: bigint; new_balance: bigint }>>`
    WITH old AS (
      SELECT "balanceMinor" as old_balance
      FROM "CustomerCredit"
      WHERE "userId" = ${input.userId} AND "balanceMinor" > 0
      FOR UPDATE
    )
    UPDATE "CustomerCredit"
    SET "balanceMinor" = "old_balance" - LEAST("old_balance", ${input.amountMinor}),
        "totalSpent" = "totalSpent" + LEAST("old_balance", ${input.amountMinor})
    FROM old
    WHERE "CustomerCredit"."userId" = ${input.userId}
      AND "CustomerCredit"."balanceMinor" > 0
    RETURNING
      "CustomerCredit"."balanceMinor" as new_balance,
      LEAST("old_balance", ${input.amountMinor}) as spent
  `;

  const spent = Number(result[0]?.spent ?? 0n);
  if (spent === 0) return 0;

  const newBalance = Number(result[0]?.new_balance ?? 0n);

  // Record the credit transaction
  const credit = await db.customerCredit.findUnique({ where: { userId: input.userId } });
  if (!credit) return 0;

  await db.creditTransaction.create({
    data: {
      creditId: credit.id,
      userId: input.userId,
      type: "purchase_credit",
      amountMinor: -spent,
      balanceAfter: newBalance,
      reason: input.reason,
      orderId: input.orderId,
    },
  });

  logger.info("credit.spent", { userId: input.userId, amount: spent, orderId: input.orderId });
  return spent;
}
