/**
 * Control Plane — Decision Engine v1
 *
 * Wraps the existing deterministic ranking engine. The ranking engine answers
 * "which candidate is better?" The decision engine answers "what should the
 * connectivity system do now?"
 *
 * Inputs:
 *   ConnectivityIntent
 *   ConnectivityOffer[] (from the ranking engine)
 *   ConnectivitySession (current state, if any)
 *   ConnectivityMeasurement[] (quality observations)
 *   ConnectivityPolicy (autonomous rules)
 *
 * Output:
 *   ConnectivityDecision
 *
 * The decision engine is PURE DETERMINISTIC — same inputs always produce
 * the same decision. No AI. The AI only extracts intent; the decision is
 * deterministic.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rankOffers } from "@/lib/commerce/ranking-engine";
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
  targetResourceId?: string;
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
  // Step 1: Rank offers using the existing deterministic ranking engine
  const ranking = await rankOffers({
    tenantId: input.tenantId,
    customerId: input.subjectId,
    capabilityType: input.capabilityType,
    desiredSpec: input.desiredSpec as any,
    location: input.location as any,
    maxPriceMinor: input.maxPriceMinor,
  });

  const constraintsSatisfied: string[] = [];
  const constraintsViolated: string[] = [];
  const reasons: string[] = [];

  // Step 2: Check if there's an active session
  const activeSession = input.sessionId
    ? await db.connectivitySession.findUnique({ where: { id: input.sessionId } })
    : null;

  // Step 3: Determine the action
  let action: DecisionOutput["action"] = "WAIT";
  let targetOfferId: string | undefined;
  let targetResourceId: string | undefined;
  let score = 0;

  if (ranking.ranked.length === 0) {
    action = "WAIT";
    reasons.push("No offers matched the intent");
    constraintsViolated.push("NO_OFFERS_AVAILABLE");
  } else {
    const topOffer = ranking.ranked[0];
    score = topOffer.score;
    targetOfferId = topOffer.offerId;

    if (activeSession && activeSession.state === "ACTIVE") {
      // There's an active session — check if we should KEEP or SWITCH
      const policy = input.policy;
      const switchThreshold = policy?.switchHysteresis ?? 0.15;

      // If the top offer's score is significantly better than the current
      // session's quality, SWITCH. Otherwise KEEP.
      // For v1, we use a simple heuristic: if the top offer score > 0.7
      // and the session has no recent measurements showing good quality, SWITCH.
      const recentMeasurements = await db.connectivityMeasurement.findMany({
        where: { sessionId: activeSession.id, capturedAt: { gte: new Date(Date.now() - 300000) } },
        orderBy: { capturedAt: "desc" },
        take: 3,
      });

      if (recentMeasurements.length === 0) {
        // No recent measurements — can't evaluate, KEEP current
        action = "KEEP";
        reasons.push("No recent measurements to evaluate switching");
        constraintsSatisfied.push("SESSION_ACTIVE");
      } else {
        // Check if current quality is degraded
        const lastMeasurement = recentMeasurements[0];
        const metrics = JSON.parse(lastMeasurement.metrics);
        const currentQuality = (metrics.throughputDownMbps ?? 0) > 0
          ? Math.min(1, (metrics.throughputDownMbps ?? 0) / 50)
          : 0.3;

        if (topOffer.score - currentQuality > switchThreshold) {
          action = "SWITCH";
          targetResourceId = topOffer.offerId; // would be resource ID in full impl
          reasons.push(`Top offer score ${topOffer.score.toFixed(2)} exceeds current quality ${currentQuality.toFixed(2)} by more than threshold ${switchThreshold}`);
          constraintsSatisfied.push("SWITCH_THRESHOLD_MET");
        } else {
          action = "KEEP";
          reasons.push(`Current quality ${currentQuality.toFixed(2)} is within threshold of top offer ${topOffer.score.toFixed(2)}`);
          constraintsSatisfied.push("SESSION_ACTIVE");
          constraintsSatisfied.push("QUALITY_ACCEPTABLE");
        }
      }
    } else {
      // No active session — ACTIVATE the top offer
      action = "ACTIVATE";
      targetResourceId = topOffer.offerId;
      reasons.push(`Top offer selected with score ${topOffer.score.toFixed(2)}`);
      constraintsSatisfied.push("OFFER_SELECTED");

      // Check policy for purchase approval
      if (input.policy?.requireUserApprovalForPurchase ?? true) {
        // For v1, we still return ACTIVATE but note that approval is needed
        reasons.push("Policy requires user approval for purchase");
      }
    }
  }

  // Step 4: Check budget constraint
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

  // Step 5: Check reliability constraint
  if (input.policy?.minReliability) {
    if (ranking.ranked.length > 0) {
      const topOffer = ranking.ranked[0];
      if (topOffer.scores.reliability >= input.policy.minReliability) {
        constraintsSatisfied.push("MEETS_RELIABILITY");
      } else {
        constraintsViolated.push("BELOW_MIN_RELIABILITY");
      }
    }
  }

  // Step 6: Persist the decision
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

  logger.info("decision.made", {
    decisionId: decision.id,
    action,
    score,
    satisfied: constraintsSatisfied.length,
    violated: constraintsViolated.length,
  });

  return {
    decisionId: decision.id,
    action,
    targetOfferId,
    targetResourceId,
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
