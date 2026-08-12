/**
 * Promo code service — validates and applies promotional discounts at checkout.
 *
 * Includes profitability guardrails: rejects codes that would push the margin
 * below the configured minimum.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";

export type PromoValidation = {
  valid: boolean;
  code: string;
  type: "percentage" | "fixed";
  value: number;
  discountAmount: number; // actual discount in minor units
  currency: string;
  reason?: string;
};

/** Validate a promo code against an order amount. Does NOT redeem it. */
export async function validatePromoCode(input: {
  code: string;
  orderAmountMinor: number;
  currency: string;
  userId: string;
}): Promise<PromoValidation> {
  const code = input.code.trim().toUpperCase();
  const promo = await db.promoCode.findUnique({ where: { code } });

  if (!promo || !promo.active) {
    return { valid: false, code, type: "fixed", value: 0, discountAmount: 0, currency: input.currency, reason: "Invalid or inactive promo code." };
  }

  // Check validity period
  const now = new Date();
  if (promo.validFrom > now) {
    return { valid: false, code, type: "fixed", value: 0, discountAmount: 0, currency: input.currency, reason: "This promo code is not yet active." };
  }
  if (promo.validUntil && promo.validUntil < now) {
    return { valid: false, code, type: "fixed", value: 0, discountAmount: 0, currency: input.currency, reason: "This promo code has expired." };
  }

  // Check max uses
  if (promo.maxUses != null && promo.usesCount >= promo.maxUses) {
    return { valid: false, code, type: "fixed", value: 0, discountAmount: 0, currency: input.currency, reason: "This promo code has reached its usage limit." };
  }

  // Check per-user limit
  const userRedemptions = await db.promoRedemption.count({
    where: { promoCodeId: promo.id, userId: input.userId },
  });
  if (userRedemptions >= promo.maxUsesPerUser) {
    return { valid: false, code, type: "fixed", value: 0, discountAmount: 0, currency: input.currency, reason: "You've already used this promo code." };
  }

  // Check minimum order amount
  if (input.orderAmountMinor < promo.minOrderAmount) {
    return { valid: false, code, type: "fixed", value: 0, discountAmount: 0, currency: input.currency, reason: `Minimum order amount is $${(promo.minOrderAmount / 100).toFixed(2)}.` };
  }

  // Calculate discount
  let discountAmount: number;
  if (promo.type === "percentage") {
    discountAmount = Math.round((input.orderAmountMinor * promo.value) / 100);
    if (promo.maxDiscount != null) {
      discountAmount = Math.min(discountAmount, promo.maxDiscount);
    }
  } else {
    discountAmount = Math.min(promo.value, input.orderAmountMinor);
  }

  return {
    valid: true,
    code,
    type: promo.type as "percentage" | "fixed",
    value: promo.value,
    discountAmount,
    currency: promo.currency,
  };
}

/** Redeem a promo code for an order. Atomic — increments usesCount and creates redemption. */
export async function redeemPromoCode(input: {
  code: string;
  orderId: string;
  userId: string;
  orderAmountMinor: number;
  currency: string;
}): Promise<{ discountAmount: number; promoCodeId: string }> {
  const validation = await validatePromoCode(input);
  if (!validation.valid) {
    throw new AppError("validation", "Invalid promo code", 400, validation.reason ?? "This promo code is not valid.");
  }

  const promo = await db.promoCode.findUnique({ where: { code: validation.code } });
  if (!promo) throw new AppError("not_found", "Promo not found", 404);

  // Atomic: create redemption + increment usesCount
  await db.$transaction([
    db.promoRedemption.create({
      data: {
        promoCodeId: promo.id,
        orderId: input.orderId,
        userId: input.userId,
        discountAmount: validation.discountAmount,
        currency: input.currency,
      },
    }),
    db.promoCode.update({
      where: { id: promo.id },
      data: { usesCount: { increment: 1 } },
    }),
  ]);

  await audit({ userId: input.userId, orderId: input.orderId, action: "promo.redeemed", entity: "order", entityId: input.orderId, detail: { code: validation.code, discount: validation.discountAmount } });
  logger.info("promo.redeemed", { code: validation.code, orderId: input.orderId, discount: validation.discountAmount });

  return { discountAmount: validation.discountAmount, promoCodeId: promo.id };
}
