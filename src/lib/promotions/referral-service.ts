/**
 * Referral + Customer Credit service.
 *
 * Referrals: each user gets a referral code. When a new user signs up with a
 * referral code, both referrer and referee get credit after the referee's
 * first purchase.
 *
 * Customer Credit: unified wallet balance across all RoamLink products.
 * Credits can be earned (referrals, promos, refunds) and spent (checkout).
 */

import { db } from "@/lib/db";
import { generateToken } from "@/lib/security";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";

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
  if (!referral) return; // silent — invalid referral code is not an error

  // Prevent self-referral
  if (referral.referrerUserId === input.refereeUserId) {
    logger.warn("referral.self_referral_blocked", { userId: input.refereeUserId });
    return;
  }

  // Check if already tracked
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

  await db.$transaction(async (tx) => {
    // Mark as completed
    await tx.referralUse.update({
      where: { id: referralUse.id },
      data: { status: "completed", orderId: input.orderId, referrerCredited: true, refereeCredited: true },
    });

    await tx.referral.update({
      where: { id: referral.id },
      data: { completedReferrals: { increment: 1 }, totalRewardPaid: { increment: referral.referrerReward + referral.refereeReward } },
    });

    // Credit referrer
    await addCreditInternal(tx, referral.referrerUserId, referral.referrerReward, "referral_reward", `Referral reward for inviting a friend`, input.orderId, referral.referrerUserId);
    // Credit referee
    await addCreditInternal(tx, input.refereeUserId, referral.refereeReward, "referral_reward", `Welcome credit from referral`, input.orderId, referral.referrerUserId);
  });

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
  await audit({ userId: input.userId, action: "credit.added", entity: "user", entityId: input.userId, detail: { amount: input.amountMinor, type: input.type } });
  logger.info("credit.added", { userId: input.userId, amount: input.amountMinor, type: input.type });
}

/** Spend credit at checkout. Returns the amount actually spent (may be less than requested). */
export async function spendCredit(input: { userId: string; amountMinor: number; orderId: string; reason: string }): Promise<number> {
  const credit = await db.customerCredit.findUnique({ where: { userId: input.userId } });
  if (!credit || credit.balanceMinor <= 0) return 0;

  const spendAmount = Math.min(credit.balanceMinor, input.amountMinor);
  const newBalance = credit.balanceMinor - spendAmount;

  await db.$transaction([
    db.customerCredit.update({
      where: { userId: input.userId },
      data: { balanceMinor: newBalance, totalSpent: { increment: spendAmount } },
    }),
    db.creditTransaction.create({
      data: {
        creditId: credit.id,
        userId: input.userId,
        type: "purchase_credit",
        amountMinor: -spendAmount,
        balanceAfter: newBalance,
        reason: input.reason,
        orderId: input.orderId,
      },
    }),
  ]);

  logger.info("credit.spent", { userId: input.userId, amount: spendAmount, orderId: input.orderId });
  return spendAmount;
}
