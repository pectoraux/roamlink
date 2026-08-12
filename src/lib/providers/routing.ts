/**
 * Provider routing — selects the best provider for a given request based on
 * capabilities, availability, cost, margin, and reliability.
 */

import { db } from "@/lib/db";
import { getESIMProvider } from "@/lib/esim";
import { getVNProvider } from "@/lib/virtual-numbers";
import { canProviderCommit } from "@/lib/finance/provider-credit";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export type ProviderCapability =
  | "PRODUCT_CATALOG"
  | "ESIM_PURCHASE"
  | "ESIM_ACTIVATION"
  | "ESIM_USAGE"
  | "ESIM_TOPUP"
  | "ESIM_REFUND"
  | "NUMBER_SEARCH"
  | "NUMBER_PROVISION"
  | "NUMBER_RENEW"
  | "NUMBER_RELEASE"
  | "SMS_INBOUND"
  | "SMS_OUTBOUND"
  | "VOICE_INBOUND"
  | "VOICE_OUTBOUND"
  | "SUBSCRIPTION";

export type ProviderRouteResult = {
  providerId: string;
  reason: string;
  cost?: number;
};

type ProviderHealth = {
  providerId: string;
  healthy: boolean;
  lastCheck: Date;
  failureCount: number;
  successCount: number;
  avgLatencyMs: number;
};

const healthRecords = new Map<string, ProviderHealth>();

export function recordProviderResult(providerId: string, success: boolean, latencyMs: number): void {
  let health = healthRecords.get(providerId);
  if (!health) {
    health = { providerId, healthy: true, lastCheck: new Date(), failureCount: 0, successCount: 0, avgLatencyMs: 0 };
    healthRecords.set(providerId, health);
  }
  if (success) {
    health.successCount++;
    health.avgLatencyMs = health.avgLatencyMs === 0 ? latencyMs : (health.avgLatencyMs * 0.8 + latencyMs * 0.2);
  } else {
    health.failureCount++;
    if (health.failureCount > 3 && health.failureCount > health.successCount * 0.5) {
      health.healthy = false;
      logger.error("provider.marked_unhealthy", { providerId, failures: health.failureCount, successes: health.successCount });
    }
  }
  health.lastCheck = new Date();
}

export function getProviderHealth(providerId: string): ProviderHealth | null {
  return healthRecords.get(providerId) ?? null;
}

async function canUseProvider(providerId: string, estimatedCost: number): Promise<{ canUse: boolean; reason?: string }> {
  const creditCheck = await canProviderCommit(providerId, estimatedCost);
  if (!creditCheck.canCommit) return creditCheck;

  const health = healthRecords.get(providerId);
  if (health && !health.healthy) {
    return { canUse: false, reason: `Provider ${providerId} is marked unhealthy.` };
  }
  return { canUse: true };
}

export async function routeESIMPurchase(input: { countryCode: string; estimatedCost: number }): Promise<ProviderRouteResult> {
  const provider = getESIMProvider();
  const canUse = await canUseProvider(provider.id, input.estimatedCost);
  if (!canUse.canUse) {
    throw new AppError("provider", "No available provider", 503, "We couldn't process your request right now.");
  }
  return { providerId: provider.id, reason: "Selected: available eSIM provider", cost: input.estimatedCost };
}

export async function routeNumberPurchase(input: { countryCode: string; smsRequired: boolean; voiceRequired: boolean; estimatedCost: number }): Promise<ProviderRouteResult> {
  const provider = getVNProvider();
  const canUse = await canUseProvider(provider.id, input.estimatedCost);
  if (!canUse.canUse) {
    throw new AppError("provider", "No available provider", 503, "We couldn't process your request right now.");
  }
  return { providerId: provider.id, reason: "Selected: available number provider", cost: input.estimatedCost };
}

export async function getProviderStatuses() {
  const esimProvider = getESIMProvider();
  const vnProvider = getVNProvider();

  const [esimCredit, vnCredit] = await Promise.all([
    db.providerCreditAccount.findUnique({ where: { provider: esimProvider.id } }),
    db.providerCreditAccount.findUnique({ where: { provider: vnProvider.id } }),
  ]);

  const esimHealth = getProviderHealth(esimProvider.id);
  const vnHealth = getProviderHealth(vnProvider.id);

  return [
    {
      providerId: esimProvider.id,
      label: esimProvider.label,
      isMock: esimProvider.isMock,
      type: "esim",
      healthy: esimHealth?.healthy ?? true,
      successCount: esimHealth?.successCount ?? 0,
      failureCount: esimHealth?.failureCount ?? 0,
      avgLatencyMs: esimHealth?.avgLatencyMs ?? 0,
      creditLimit: esimCredit?.creditLimit ?? 0,
      outstandingLiability: esimCredit?.outstandingLiability ?? 0,
      availableCredit: esimCredit ? esimCredit.creditLimit - esimCredit.outstandingLiability - esimCredit.pendingCommitments : 0,
    },
    {
      providerId: vnProvider.id,
      label: vnProvider.label,
      isMock: vnProvider.isMock,
      type: "virtual_number",
      healthy: vnHealth?.healthy ?? true,
      successCount: vnHealth?.successCount ?? 0,
      failureCount: vnHealth?.failureCount ?? 0,
      avgLatencyMs: vnHealth?.avgLatencyMs ?? 0,
      creditLimit: vnCredit?.creditLimit ?? 0,
      outstandingLiability: vnCredit?.outstandingLiability ?? 0,
      availableCredit: vnCredit ? vnCredit.creditLimit - vnCredit.outstandingLiability - vnCredit.pendingCommitments : 0,
    },
  ];
}
