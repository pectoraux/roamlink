/**
 * Usage service — syncs usage from the provider and records samples.
 * Also handles simulated usage (dev) and expiration checks.
 */

import { db } from "@/lib/db";
import { getESIMProvider } from "@/lib/esim";
import { logger } from "@/lib/logger";

/** Sync current usage for an eSIM from the provider. */
export async function syncUsage(esimId: string): Promise<{ dataRemainingMB: number; status: string }> {
  const esim = await db.esim.findUnique({ where: { id: esimId } });
  if (!esim) throw new Error("eSIM not found");
  if (!esim.providerESIMId) throw new Error("eSIM has no provider id");

  const provider = getESIMProvider();
  const sample = await provider.getUsage(esim.providerESIMId);

  const used = esim.dataAmount - sample.dataRemainingMB;
  await db.usage.create({
    data: {
      esimId,
      dataUsed: Math.max(0, used),
      dataRemaining: sample.dataRemainingMB,
      source: "provider",
    },
  });

  let status = esim.status;
  if (sample.dataRemainingMB <= 0) status = "exhausted";
  if (esim.expiresAt && new Date(esim.expiresAt) < new Date()) status = "expired";

  await db.esim.update({ where: { id: esimId }, data: { dataRemaining: sample.dataRemainingMB, status } });
  logger.info("usage.synced", { esimId, remaining: sample.dataRemainingMB });
  return { dataRemainingMB: sample.dataRemainingMB, status };
}

/** Simulate data consumption on an eSIM (dev only, uses mock provider). */
export async function simulateUsage(esimId: string, usedMB: number): Promise<{ dataRemainingMB: number; status: string }> {
  const esim = await db.esim.findUnique({ where: { id: esimId } });
  if (!esim) throw new Error("eSIM not found");

  const newRemaining = Math.max(0, esim.dataRemaining - usedMB);
  let status = esim.status;
  if (newRemaining <= 0) status = "exhausted";

  await db.usage.create({
    data: { esimId, dataUsed: usedMB, dataRemaining: newRemaining, source: "simulated" },
  });
  await db.esim.update({ where: { id: esimId }, data: { dataRemaining: newRemaining, status } });
  logger.info("usage.simulated", { esimId, used: usedMB, remaining: newRemaining });
  return { dataRemainingMB: newRemaining, status };
}

/** Get usage history for an eSIM. */
export async function getUsageHistory(esimId: string, limit = 20) {
  return db.usage.findMany({ where: { esimId }, orderBy: { timestamp: "desc" }, take: limit });
}

/** Check all eSIMs for expiration (background job). */
export async function checkExpirations(): Promise<{ expired: number }> {
  const now = new Date();
  const result = await db.esim.updateMany({
    where: { status: { in: ["active", "pending"] }, expiresAt: { lt: now } },
    data: { status: "expired" },
  });
  if (result.count > 0) logger.info("usage.expirations_updated", { count: result.count });
  return { expired: result.count };
}
