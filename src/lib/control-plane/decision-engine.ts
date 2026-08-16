/**
 * Control Plane — Decision Engine v2 (Phase 8.4)
 *
 * CHANGED FROM v1:
 *   v1: Intent → rankOffers() → topOffer.offerId as "resourceId" (WRONG)
 *   v2: Intent → discoverCapabilities() → discoverResources() → ProtocolResource.id (CORRECT)
 *
 * The decision engine now resolves a concrete ProtocolResource, not a
 * ConnectivityOffer2 ID. Offers are still queried for pricing/scoring, but
 * the targetResourceId always references a ProtocolResource.id.
 *
 * Hysteresis (Phase 8.3): M-of-N degraded measurements required, not just count >= 2.
 *
 * Policy (Phase 8.3): evaluatePolicy() is called before the action proceeds.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rankOffers } from "@/lib/commerce/ranking-engine";
import { getPolicy, evaluatePolicy } from "@/lib/control-plane/policy-engine";
import { discoverCapabilities, discoverResources } from "@/lib/control-plane/capability-registry";
import type { ConnectivityPolicy } from "@/lib/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionInput = {
  tenantId: string;
  subjectId: string;
  intentId?: string;
  sessionId?: string;
  rawText?: string;
  capabilityType?: string;
  desiredSpec?: Record<string, unknown>;
  location?: Record<string, unknown>;
  maxPriceMinor?: number;
  policy?: ConnectivityPolicy;
};

export type DecisionOutput = {
  decisionId: string;
  action: "KEEP" | "SWITCH" | "ACTIVATE" | "RESERVE" | "RENEW" | "RELEASE" | "WAIT" | "ASK_USER";
  targetOfferId?: string;
  targetResourceId?: string; // ALWAYS a ProtocolResource.id, never an offer ID
  targetCapabilityId?: string;
  score: number;
  constraintsSatisfied: string[];
  constraintsViolated: string[];
  reasons: string[];
  rankedOffers: Array<{ offerId: string; score: number; customerPriceMinor: number }>;
};

// ---------------------------------------------------------------------------
// Make Decision
// ---------------------------------------------------------------------------

export async function makeDecision(input: DecisionInput): Promise<DecisionOutput> {
  const constraintsSatisfied: string[] = [];
  const constraintsViolated: string[] = [];
  const reasons: string[] = [];

  // Step 1: Discover capabilities (first-class ProtocolCapability)
  const capabilities = await discoverCapabilities({
    tenantId: input.tenantId,
    type: input.capabilityType,
    country: (input.location as Record<string, unknown>)?.country as string | undefined,
    city: (input.location as Record<string, unknown>)?.city as string | undefined,
  });

  // Step 2: For each capability, discover AVAILABLE resources
  let bestResource: { id: string; capabilityId: string } | null = null;
  let bestCapability: { id: string; type: string; providerType: string; reliability: number } | null = null;

  for (const cap of capabilities) {
    const resources = await discoverResources(cap.id);
    if (resources.length > 0) {
      // Pick the first available resource (round-robin via createdAt ordering)
      bestResource = { id: resources[0].id, capabilityId: cap.id };
      bestCapability = cap;
      break;
    }
  }

  // Step 3: Also rank offers for pricing/scoring (commerce layer, unchanged)
  const ranking = await rankOffers({
    tenantId: input.tenantId,
    customerId: input.subjectId,
    capabilityType: input.capabilityType,
    desiredSpec: input.desiredSpec as any,
    location: input.location as any,
    maxPriceMinor: input.maxPriceMinor,
  });

  let action: DecisionOutput["action"] = "WAIT";
  let targetOfferId: string | undefined;
  let targetResourceId: string | undefined;
  let targetCapabilityId: string | undefined;
  let score = 0;

  if (!bestResource || !bestCapability) {
    // No available resources
    if (ranking.ranked.length > 0) {
      // There are offers but no resources — might need provisioning
      action = "WAIT";
      reasons.push("Offers exist but no AVAILABLE resources found — provisioning may be needed");
      constraintsViolated.push("NO_AVAILABLE_RESOURCES");
    } else {
      action = "WAIT";
      reasons.push("No capabilities or offers matched the intent");
      constraintsViolated.push("NO_CAPABILITIES_AVAILABLE");
    }
  } else {
    targetResourceId = bestResource.id; // ProtocolResource.id — NOT an offer ID
    targetCapabilityId = bestCapability.id;
    score = bestCapability.reliability; // use capability reliability as base score

    // If there's a matching offer, use its score
    const matchingOffer = ranking.ranked.find((r) =>
      r.offer.capabilityType === bestCapability!.type
    );
    if (matchingOffer) {
      targetOfferId = matchingOffer.offerId;
      score = matchingOffer.score;
    }

    // Step 4: Check if there's an active session
    const activeSession = input.sessionId
      ? await db.connectivitySession.findUnique({ where: { id: input.sessionId } })
      : null;

    if (activeSession && activeSession.state === "ACTIVE") {
      // Active session — evaluate KEEP vs SWITCH
      const policy = input.policy;
      const switchThreshold = policy?.switchHysteresis ?? 0.15;

      // Hysteresis parameters
      const MIN_DWELL_MS = 60_000;
      const COOLDOWN_MS = 120_000;
      const MIN_MEASUREMENTS_FOR_SWITCH = 3; // need at least 3 measurements
      const MIN_DEGRADED_COUNT = 2; // at least 2 of them must show degradation
      const DEGRADATION_THRESHOLD = 0.4; // quality below this = degraded

      // Check dwell time
      if (activeSession.startedAt && Date.now() - activeSession.startedAt.getTime() < MIN_DWELL_MS) {
        action = "KEEP";
        reasons.push(`Session started <${MIN_DWELL_MS / 1000}s ago — dwell time not met`);
        constraintsSatisfied.push("DWELL_TIME_ENFORCED");
      } else {
        // Check cooldown
        const recentSwitch = await db.connectivityAction.findFirst({
          where: {
            sessionId: activeSession.id,
            type: "SWITCH",
            state: "SUCCEEDED",
            completedAt: { gte: new Date(Date.now() - COOLDOWN_MS) },
          },
        });

        if (recentSwitch) {
          action = "KEEP";
          reasons.push(`Last switch was <${COOLDOWN_MS / 1000}s ago — cooldown active`);
          constraintsSatisfied.push("COOLDOWN_ENFORCED");
        } else {
          // Fetch recent measurements
          const recentMeasurements = await db.connectivityMeasurement.findMany({
            where: { sessionId: activeSession.id, capturedAt: { gte: new Date(Date.now() - 300000) } },
            orderBy: { capturedAt: "desc" },
            take: 5,
          });

          if (recentMeasurements.length < MIN_MEASUREMENTS_FOR_SWITCH) {
            action = "KEEP";
            reasons.push(`Only ${recentMeasurements.length} measurement(s) — need ${MIN_MEASUREMENTS_FOR_SWITCH} for switch confidence`);
            constraintsSatisfied.push("CONFIDENCE_THRESHOLD_ENFORCED");
          } else {
            // Phase 8.4: M-of-N degraded check — not just the latest measurement
            const degradedMeasurements = recentMeasurements.filter((m) => {
              const metrics = JSON.parse(m.metrics);
              const quality = (metrics.throughputDownMbps ?? 0) > 0
                ? Math.min(1, (metrics.throughputDownMbps ?? 0) / 50)
                : 0.3;
              return quality < DEGRADATION_THRESHOLD;
            });

            if (degradedMeasurements.length >= MIN_DEGRADED_COUNT) {
              // M-of-N degraded — eligible to switch
              const avgQuality = recentMeasurements.reduce((sum, m) => {
                const metrics = JSON.parse(m.metrics);
                const q = (metrics.throughputDownMbps ?? 0) > 0
                  ? Math.min(1, (metrics.throughputDownMbps ?? 0) / 50)
                  : 0.3;
                return sum + q;
              }, 0) / recentMeasurements.length;

              if (score - avgQuality > switchThreshold) {
                action = "SWITCH";
                reasons.push(`${degradedMeasurements.length}/${recentMeasurements.length} measurements degraded — switch threshold met (avg quality ${avgQuality.toFixed(2)} vs candidate ${score.toFixed(2)})`);
                constraintsSatisfied.push("SWITCH_THRESHOLD_MET");
                constraintsSatisfied.push("M_OF_N_DEGRADED");
                constraintsSatisfied.push("HYSTERESIS_PASSED");
              } else {
                action = "KEEP";
                reasons.push(`Degraded but improvement ${score.toFixed(2)} - ${avgQuality.toFixed(2)} < threshold ${switchThreshold}`);
                constraintsSatisfied.push("QUALITY_ACCEPTABLE");
              }
            } else {
              action = "KEEP";
              reasons.push(`Only ${degradedMeasurements.length}/${recentMeasurements.length} measurements degraded — need ${MIN_DEGRADED_COUNT} for switch`);
              constraintsSatisfied.push("QUALITY_ACCEPTABLE");
            }
          }
        }
      }
    } else {
      // No active session — ACTIVATE
      action = "ACTIVATE";
      reasons.push(`Resource ${bestResource.id} (capability ${bestCapability.type}) selected with reliability ${bestCapability.reliability.toFixed(2)}`);
      constraintsSatisfied.push("RESOURCE_SELECTED");
      constraintsSatisfied.push("CAPABILITY_RESOLVED");
    }
  }

  // Step 5: Budget check
  if (input.maxPriceMinor && ranking.ranked.length > 0) {
    const topOffer = ranking.ranked[0];
    if (topOffer.customerPriceMinor <= input.maxPriceMinor) {
      constraintsSatisfied.push("WITHIN_BUDGET");
    } else {
      constraintsViolated.push("OVER_BUDGET");
      if (action === "ACTIVATE") {
        action = "ASK_USER";
        reasons.push("Top offer exceeds budget — user approval required");
      }
    }
  }

  // Step 6: Reliability check
  if (input.policy?.minReliability && bestCapability) {
    if (bestCapability.reliability >= input.policy.minReliability) {
      constraintsSatisfied.push("MEETS_RELIABILITY");
    } else {
      constraintsViolated.push("BELOW_MIN_RELIABILITY");
    }
  }

  // Step 7: Policy evaluation
  const policy = input.policy ?? await getPolicy(input.subjectId);
  const policyResult = evaluatePolicy({
    policy,
    action: action === "ACTIVATE" ? "ACTIVATE" : action === "SWITCH" ? "SWITCH" : "KEEP",
    estimatedCostMinor: ranking.ranked[0]?.customerPriceMinor,
  });

  if (!policyResult.allowed && action !== "KEEP" && action !== "WAIT") {
    reasons.push(`Policy blocked action: ${policyResult.reason}`);
    constraintsViolated.push("POLICY_BLOCKED");
    action = "ASK_USER";
  } else if (policyResult.allowed) {
    constraintsSatisfied.push("POLICY_ALLOWED");
  }

  // Step 8: Persist
  const decision = await db.connectivityDecision.create({
    data: {
      intentId: input.intentId ?? "unknown",
      sessionId: input.sessionId ?? null,
      action,
      targetResourceId: targetResourceId ?? null,
      targetOfferId: targetOfferId ?? null,
      score,
      constraintsSatisfied: JSON.stringify(constraintsSatisfied),
      constraintsViolated: JSON.stringify(constraintsViolated),
      reasons: JSON.stringify(reasons),
      policyVersion: input.policy?.id ?? "default",
    },
  });

  logger.info("decision.made_v2", {
    decisionId: decision.id,
    action,
    score,
    targetResourceId,
    targetCapabilityId,
    satisfied: constraintsSatisfied.length,
    violated: constraintsViolated.length,
  });

  return {
    decisionId: decision.id,
    action,
    targetOfferId,
    targetResourceId,
    targetCapabilityId,
    score,
    constraintsSatisfied,
    constraintsViolated,
    reasons,
    rankedOffers: ranking.ranked.slice(0, 5).map((r) => ({
      offerId: r.offerId,
      score: r.score,
      customerPriceMinor: r.customerPriceMinor,
    })),
  };
}
