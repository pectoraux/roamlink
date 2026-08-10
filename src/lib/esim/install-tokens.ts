/**
 * Installation token service — generates short-lived, secure tokens for
 * web→mobile deep linking. The web app generates a token after purchase; the
 * mobile app consumes it to access the eSIM installation details.
 *
 * Tokens are:
 *  - Opaque (not the eSIM ID or activation code)
 *  - Short-lived (15 minutes)
 *  - Single-use (consumed on first access)
 *  - Bound to the user (only the owner can use them)
 *
 * This avoids putting raw activation secrets into permanent URLs.
 */

import { db } from "@/lib/db";
import { generateToken } from "@/lib/security";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const TOKEN_TTL_MINUTES = 15;

/** Generate a short-lived installation token for an eSIM. */
export async function createInstallToken(userId: string, esimId: string): Promise<{ token: string; expiresAt: string }> {
  // Verify ownership
  const esim = await db.esim.findUnique({ where: { id: esimId } });
  if (!esim || esim.userId !== userId) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);
  await db.installToken.create({ data: { token, userId, esimId, expiresAt } });
  logger.info("install_token.created", { userId, esimId, expiresAt });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Consume an installation token — returns the eSIM installation details.
 * Single-use: the token is invalidated after consumption.
 * Requires the same user to consume it.
 */
export async function consumeInstallToken(userId: string, token: string): Promise<{
  esimId: string;
  iccid: string | null;
  smdpAddress: string | null;
  activationCode: string | null;
  matchId: string | null;
  qrCode: string | null;
  country: string;
  planName: string;
}> {
  const entry = await db.installToken.findUnique({ where: { token } });
  if (!entry) throw new AppError("not_found", "Invalid token", 404, "This installation link is invalid.");
  if (entry.userId !== userId) throw new AppError("authorization", "Token mismatch", 403, "This installation link belongs to a different account.");
  if (entry.usedAt) throw new AppError("conflict", "Token already used", 409, "This installation link has already been used.");
  if (entry.expiresAt < new Date()) throw new AppError("auth", "Token expired", 401, "This installation link has expired. Please generate a new one.");

  const esim = await db.esim.findUnique({ where: { id: entry.esimId }, include: { order: { include: { plan: true } } } });
  if (!esim) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");

  // Mark token as used
  await db.installToken.update({ where: { id: entry.id }, data: { usedAt: new Date() } });
  logger.info("install_token.consumed", { userId, esimId: esim.id });

  return {
    esimId: esim.id,
    iccid: esim.iccid,
    smdpAddress: esim.smdpAddress,
    activationCode: esim.activationCode,
    matchId: esim.matchId,
    qrCode: esim.qrCode,
    country: esim.order.plan.country,
    planName: esim.order.plan.name,
  };
}
