/**
 * Control Plane — Current Connectivity Read Model (Phase 9.2)
 *
 * A read-only projection of the user's current connectivity state, derived
 * from the existing session/resource/health/decision projections.
 *
 * This is STRICTLY read-only. The mobile UI consumes it to display state;
 * it has no control-plane authority. The server remains authoritative.
 *
 *   GET /api/v1/connectivity/current
 *     → authenticate user
 *     → find active session for user
 *     → project session + resource + health + decision → CurrentConnectivity
 *
 * The endpoint cannot expose another user's resource — it's scoped to the
 * authenticated user's sessions only.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { REASON_CODES, type ReasonCode, parseReasonCodesWithIntegrity } from "@roamlink/shared";
import type {
  CurrentConnectivity,
  CurrentConnectivitySession,
  CurrentConnectivityCapability,
  CurrentConnectivityHealth,
  CurrentConnectivityDecision,
  CurrentConnectivityTransition,
} from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Derive the read model for the authenticated user
// ---------------------------------------------------------------------------

/**
 * Build the CurrentConnectivity read model for a user. Finds the user's
 * active session and projects its state + health + decision.
 *
 * Returns a null session if the user has no active connectivity.
 */
export async function getCurrentConnectivityForUser(userId: string): Promise<CurrentConnectivity> {
  const serverTime = new Date().toISOString();

  // Find the user's active session (subjectId = userId)
  const session = await db.connectivitySession.findFirst({
    where: {
      subjectId: userId,
      state: { in: ["ACTIVE", "DEGRADED", "SWITCHING", "RESERVED", "DISCOVERING"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      decisions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (!session) {
    return {
      session: null,
      capability: null,
      health: null,
      decision: null,
      transition: null,
      serverTime,
    };
  }

  // Project the session
  const sessionProjection: CurrentConnectivitySession = {
    id: session.id,
    state: session.state as CurrentConnectivitySession["state"],
    activeResourceId: session.activeResourceId,
    startedAt: session.startedAt?.toISOString() ?? null,
    lastObservedAt: session.lastObservedAt?.toISOString() ?? null,
  };

  // Project the capability (from the active resource's capability)
  let capability: CurrentConnectivityCapability | null = null;
  let health: CurrentConnectivityHealth | null = null;

  if (session.activeResourceId) {
    const resource = await db.protocolResource.findUnique({
      where: { id: session.activeResourceId },
      include: { capability: true },
    });

    if (resource?.capability) {
      const cap = resource.capability;
      const coverage = cap.coverage ? JSON.parse(cap.coverage) : {};
      capability = {
        type: cap.type,
        providerType: cap.providerType,
        transportLabel: mapTransportLabel(cap.type, cap.providerType),
        location: {
          country: (coverage as Record<string, unknown>)?.country as string | undefined,
          city: (coverage as Record<string, unknown>)?.city as string | undefined,
        },
      };

      // Project the health (from ResourceHealth)
      const healthRow = await db.resourceHealth.findUnique({
        where: { resourceId: session.activeResourceId },
      });

      if (healthRow) {
        // Get the latest measurement for detailed metrics
        const latestMeasurement = healthRow.latestMeasurementId
          ? await db.connectivityMeasurement.findUnique({ where: { id: healthRow.latestMeasurementId } })
          : null;

        const metrics = latestMeasurement?.metrics ? JSON.parse(latestMeasurement.metrics) : {};

        health = {
          status: healthRow.status as "HEALTHY" | "DEGRADED" | "UNKNOWN",
          qualityScore: healthRow.quality,
          reliability: cap.reliability,
          latencyMs: metrics.latencyMs as number | undefined,
          packetLossPct: metrics.packetLossPercent as number | undefined,
          bandwidthDownMbps: metrics.throughputDownMbps as number | undefined,
          bandwidthUpMbps: metrics.throughputUpMbps as number | undefined,
          observedAt: latestMeasurement?.capturedAt?.toISOString() ?? null,
          freshness: healthRow.freshness as "FRESH" | "STALE" | "EXPIRED" | "UNKNOWN",
          explanation: mapHealthExplanation(healthRow.status, healthRow.freshness, metrics),
        };
      } else {
        health = {
          status: "UNKNOWN",
          qualityScore: 0,
          reliability: cap.reliability,
          observedAt: null,
          freshness: "UNKNOWN",
          explanation: "No health data available yet — awaiting observation.",
        };
      }
    }
  }

  // Project the most recent decision
  let decision: CurrentConnectivityDecision | null = null;
  const latestDecision = session.decisions[0];
  if (latestDecision) {
    // Phase 9.5.5: Parse reason codes with full integrity tracking.
    // Distinguishes ABSENT / MALFORMED / UNKNOWN_CODE / VALID rather than
    // silently collapsing all non-valid states to [].
    // Unknown/malformed codes are logged as data-integrity warnings —
    // the valid subset is still exposed to consumers.
    const parsed = parseReasonCodesWithIntegrity(latestDecision.reasonCodes);

    if (parsed.integrity === "MALFORMED") {
      logger.error("current_connectivity.malformed_reason_codes", {
        sessionId: session.id,
        decisionId: latestDecision.id,
        raw: latestDecision.reasonCodes?.slice(0, 200),
      });
    } else if (parsed.integrity === "UNKNOWN_CODE") {
      logger.warn("current_connectivity.unknown_reason_codes", {
        sessionId: session.id,
        decisionId: latestDecision.id,
        unknownCodes: parsed.unknownCodes,
        validCount: parsed.codes.length,
      });
    }

    decision = {
      action: latestDecision.action,
      statusLabel: mapDecisionStatusLabel(latestDecision.action, session.state),
      reasons: latestDecision.reasons ? JSON.parse(latestDecision.reasons) : [],
      reasonCodes: parsed.codes,
      createdAt: latestDecision.createdAt?.toISOString() ?? null,
    };
  }

  // Project any ongoing transition
  let transition: CurrentConnectivityTransition | null = null;
  if (session.state === "SWITCHING") {
    transition = {
      state: "SWITCHING",
      startedAt: session.startedAt?.toISOString() ?? null,
      description: "RoamLink is switching to a better connection.",
    };
  } else if (session.state === "DEGRADED") {
    transition = {
      state: "DEGRADED",
      startedAt: session.startedAt?.toISOString() ?? null,
      description: "Connection quality is degraded. RoamLink is evaluating alternatives.",
    };
  }

  logger.info("current_connectivity.served", {
    userId, sessionId: session.id, state: session.state,
    healthStatus: health?.status, decisionAction: decision?.action,
  });

  return {
    session: sessionProjection,
    capability,
    health,
    decision,
    transition,
    serverTime,
  };
}

// ---------------------------------------------------------------------------
// Label helpers (human-readable projections)
// ---------------------------------------------------------------------------

function mapTransportLabel(capabilityType: string, providerType: string): string {
  if (capabilityType === "ROAMING") return "eSIM";
  if (providerType === "mikrotik") return "WiFi";
  if (providerType === "esim") return "Cellular";
  if (providerType === "mock") return "WiFi";
  return "Connectivity";
}

function mapHealthExplanation(
  status: string,
  freshness: string,
  metrics: Record<string, unknown>,
): string {
  if (freshness === "EXPIRED") {
    return "Measurement is stale — RoamLink is re-observing.";
  }
  if (status === "HEALTHY") {
    const latency = metrics.latencyMs as number | undefined;
    const loss = metrics.packetLossPercent as number | undefined;
    if (latency !== undefined && loss !== undefined && loss < 1) {
      return `Reliable connection with low latency (${Math.round(latency)}ms).`;
    }
    return "Connection is healthy.";
  }
  if (status === "DEGRADED") {
    const latency = metrics.latencyMs as number | undefined;
    const loss = metrics.packetLossPercent as number | undefined;
    if (latency !== undefined && latency > 200) {
      return `Latency is elevated (${Math.round(latency)}ms). RoamLink is evaluating alternatives.`;
    }
    if (loss !== undefined && loss > 2) {
      return `Packet loss has exceeded your normal threshold (${loss.toFixed(1)}%).`;
    }
    return "Connection quality is declining. RoamLink is evaluating alternatives.";
  }
  return "No health data available yet.";
}

function mapDecisionStatusLabel(action: string, sessionState: string): string {
  if (sessionState === "SWITCHING") return "Switching connection";
  if (action === "KEEP") return "Optimizing automatically";
  if (action === "SWITCH") return "Evaluating alternatives";
  if (action === "ACTIVATE") return "Activating connectivity";
  if (action === "WAIT") return "Monitoring";
  if (action === "ASK_USER") return "Awaiting user input";
  return "Optimizing automatically";
}
