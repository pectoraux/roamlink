/**
 * Control Plane — Continuous Observation (Phase 8.6)
 *
 * The continuous observation loop: probes the provider adapter for usage/quality
 * and feeds the result into the measurement store as a first-class event with
 * provenance `ADAPTER`.
 *
 *   Provider Adapter (getUsage)
 *         │
 *         ▼
 *   Observation (probeAndIngest)
 *         │
 *         ▼
 *   Measurement Store (ingestMeasurement, source=ADAPTER)
 *         │
 *         ▼
 *   Health Derivation → Decision Engine (via re-evaluation)
 *
 * This is the entry point a periodic worker (cron) calls for each active
 * session/resource. It never calls provider APIs directly except through the
 * registered adapter — preserving the frozen adapter contract.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveBindingAdapter, type ConnectivityProviderAdapter } from "@/lib/connectivity";
import type { ConnectivityEntitlementInput, ProviderResourceBindingInput, UsageMetrics } from "@/lib/connectivity/adapter";
import { ingestMeasurement } from "./measurement-store";

// ---------------------------------------------------------------------------
// Map DB records → adapter input shapes
// ---------------------------------------------------------------------------

async function loadAdapterInputs(bindingId: string): Promise<{
  adapter: ConnectivityProviderAdapter;
  entitlement: ConnectivityEntitlementInput;
  binding: ProviderResourceBindingInput;
  providerResourceId: string | null;
} | null> {
  const { adapter, binding } = await resolveBindingAdapter(bindingId);

  const fullBinding = await db.providerResourceBinding.findUnique({
    where: { id: bindingId },
    include: {
      entitlement: { include: { capability: { select: { type: true } } } },
      providerInstance: { select: { configuration: true } },
    },
  });

  if (!fullBinding || !fullBinding.entitlement) {
    return null;
  }

  const ent = fullBinding.entitlement;
  const entitlement: ConnectivityEntitlementInput = {
    id: ent.id,
    tenantId: ent.tenantId,
    subscriptionId: ent.subscriptionId,
    status: ent.status,
    capabilityType: ent.capability?.type ?? "INTERNET",
    capabilitySet: JSON.parse(ent.capabilitySet),
    policy: ent.policy ? JSON.parse(ent.policy) : null,
    validFrom: ent.validFrom,
    validUntil: ent.validUntil ?? null,
  };

  const providerInstanceConfiguration = fullBinding.providerInstance?.configuration
    ? JSON.parse(fullBinding.providerInstance.configuration)
    : null;

  const bindingInput: ProviderResourceBindingInput = {
    id: fullBinding.id,
    entitlementId: fullBinding.entitlementId,
    providerType: fullBinding.providerType,
    providerResourceId: fullBinding.providerResourceId,
    providerMetadata: fullBinding.providerMetadata ? JSON.parse(fullBinding.providerMetadata) : null,
    status: fullBinding.status,
    provisioningState: fullBinding.provisioningState,
    providerInstanceId: fullBinding.providerInstanceId,
    providerInstanceConfiguration,
  };

  return { adapter, entitlement, binding: bindingInput, providerResourceId: fullBinding.providerResourceId };
}

// ---------------------------------------------------------------------------
// Convert adapter UsageMetrics → measurement metrics
// ---------------------------------------------------------------------------

function usageToMetrics(usage: UsageMetrics): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  if (usage.currentDownloadMbps !== undefined) metrics.throughputDownMbps = usage.currentDownloadMbps;
  if (usage.currentUploadMbps !== undefined) metrics.throughputUpMbps = usage.currentUploadMbps;
  if (usage.downloadBytes !== undefined) metrics.dataUsedBytes = usage.downloadBytes;
  if (usage.totalBytes !== undefined && usage.downloadBytes !== undefined) {
    metrics.dataRemainingBytes = Math.max(0, usage.totalBytes - usage.downloadBytes);
  }
  if (usage.isActive !== undefined) metrics.availability = usage.isActive ? 1 : 0;
  if (usage.sessionDurationSeconds !== undefined) metrics.sessionDurationSeconds = usage.sessionDurationSeconds;
  return metrics;
}

// ---------------------------------------------------------------------------
// Probe a single resource
// ---------------------------------------------------------------------------

export type ProbeResult = {
  resourceId: string;
  probed: boolean;
  measurementId?: string;
  freshness?: string;
  healthStatus?: string;
  reason?: string;
};

/**
 * Probe a resource via its provider adapter and ingest the result.
 *
 * The measurement is recorded with provenance `ADAPTER`. If the resource has
 * no linked provider binding, the probe is a no-op (logged).
 */
export async function probeAndIngest(resourceId: string, sessionId?: string): Promise<ProbeResult> {
  const resource = await db.protocolResource.findUnique({
    where: { id: resourceId },
    select: { id: true, providerBindingId: true, capability: { select: { tenantId: true, providerInstanceId: true } } },
  });

  if (!resource) {
    return { resourceId, probed: false, reason: "resource-not-found" };
  }

  if (!resource.providerBindingId) {
    // No binding yet — nothing to probe. This is expected for resources that
    // have not been activated.
    return { resourceId, probed: false, reason: "no-provider-binding" };
  }

  const inputs = await loadAdapterInputs(resource.providerBindingId);
  if (!inputs) {
    return { resourceId, probed: false, reason: "binding-or-entitlement-missing" };
  }

  const { adapter, entitlement, binding } = inputs;

  let usage: UsageMetrics | undefined;
  try {
    usage = await adapter.getUsage({ entitlement, binding });
  } catch (err) {
    logger.warn("observation.probe_error", {
      resourceId, bindingId: resource.providerBindingId, error: err instanceof Error ? err.message : String(err),
    });
    return { resourceId, probed: false, reason: "adapter-getUsage-error" };
  }

  if (!usage) {
    return { resourceId, probed: false, reason: "adapter-returned-no-usage" };
  }

  const result = await ingestMeasurement({
    resourceId,
    sessionId,
    providerInstanceId: resource.capability?.providerInstanceId,
    type: "QUALITY",
    metrics: usageToMetrics(usage),
    source: "ADAPTER",
    confidence: 0.8, // adapter-reported is fairly trustworthy
    capturedAt: usage.measuredAt ?? new Date(),
  });

  return {
    resourceId,
    probed: true,
    measurementId: result.measurementId,
    freshness: result.freshness,
    healthStatus: result.health?.status,
  };
}

// ---------------------------------------------------------------------------
// Probe the active resource of a session (continuous-loop entry)
// ---------------------------------------------------------------------------

export async function probeSession(sessionId: string): Promise<ProbeResult | null> {
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { id: true, activeResourceId: true, state: true },
  });

  if (!session || !session.activeResourceId) {
    return null;
  }

  if (!["ACTIVE", "DEGRADED", "SWITCHING"].includes(session.state)) {
    return null;
  }

  return probeAndIngest(session.activeResourceId, sessionId);
}

// ---------------------------------------------------------------------------
// Probe all active sessions (worker entry point)
// ---------------------------------------------------------------------------

export async function probeAllActiveSessions(): Promise<{ probed: number; results: ProbeResult[] }> {
  const sessions = await db.connectivitySession.findMany({
    where: { state: { in: ["ACTIVE", "DEGRADED"] }, activeResourceId: { not: null } },
    select: { id: true, activeResourceId: true },
  });

  const results: ProbeResult[] = [];
  for (const session of sessions) {
    if (!session.activeResourceId) continue;
    const r = await probeAndIngest(session.activeResourceId, session.id);
    results.push(r);
  }

  logger.info("observation.probe_all", { probed: results.length });
  return { probed: results.length, results };
}
