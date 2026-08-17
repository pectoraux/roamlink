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
import { getResourceHealth } from "@/lib/control-plane/health-derivation";
import { mayTriggerAutomaticSwitch } from "@/lib/control-plane/freshness";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Phase 9.3.2: The policy escape hatch is REMOVED. Policy resolution is now
// an internal control-plane operation — the decision engine ALWAYS derives
// the effective policy from base policy + device context (if deviceId is
// provided) or base policy alone.
//
// This prevents a future caller from accidentally bypassing the
// effective-policy boundary by passing a pre-resolved policy object.
export type DecisionInput = {
  tenantId: string;
  subjectId: string;
  intentId?: string;
  // Phase 9.4: Intent version for provenance
  intentVersion?: number;
  sessionId?: string;
  rawText?: string;
  capabilityType?: string;
  desiredSpec?: Record<string, unknown>;
  location?: Record<string, unknown>;
  maxPriceMinor?: number;
  deviceId?: string;
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

  // Phase 9.3.2: Resolve the effective policy FIRST (before anything else).
  // Policy resolution is INTERNAL — no caller-supplied escape hatch.
  const { deriveEffectivePolicy } = await import("./effective-policy");
  const effectivePolicy = input.deviceId
    ? await deriveEffectivePolicy(input.subjectId, input.deviceId)
    : await deriveEffectivePolicy(input.subjectId);

  // Step 1: Discover capabilities (first-class ProtocolCapability)
  const capabilities = await discoverCapabilities({
    tenantId: input.tenantId,
    type: input.capabilityType,
    country: (input.location as Record<string, unknown>)?.country as string | undefined,
    city: (input.location as Record<string, unknown>)?.city as string | undefined,
  });

  // Step 2: For each capability, discover ALL available resources and score them
  // Phase 8.5.5: evaluate all candidates, not just first available.
  type Candidate = {
    resourceId: string;
    capabilityId: string;
    capabilityType: string;
    providerType: string;
    reliability: number;
    score: number;
  };

  const candidates: Candidate[] = [];

  for (const cap of capabilities) {
    const resources = await discoverResources(cap.id);
    for (const resource of resources) {
      // Score each resource based on capability reliability + capacity
      let resourceScore = cap.reliability;

      // Boost score if resource has capacity info
      if (resource.capacity) {
        const capacity = resource.capacity as Record<string, unknown>;
        const available = capacity.availableBandwidthMbps as number | undefined;
        if (available && available > 0) {
          resourceScore = Math.min(1.0, resourceScore + (available / 1000));
        }
      }

      candidates.push({
        resourceId: resource.id,
        capabilityId: cap.id,
        capabilityType: cap.type,
        providerType: cap.providerType,
        reliability: cap.reliability,
        score: resourceScore,
      });
    }
  }

  // Sort candidates by score descending — best resource first
  candidates.sort((a, b) => b.score - a.score);

  const bestCandidate = candidates[0] ?? null;
  const bestResource = bestCandidate ? { id: bestCandidate.resourceId, capabilityId: bestCandidate.capabilityId } : null;
  const bestCapability = bestCandidate
    ? { id: bestCandidate.capabilityId, type: bestCandidate.capabilityType, providerType: bestCandidate.providerType, reliability: bestCandidate.reliability }
    : null;

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

    // Phase 9.3.2: effectivePolicy was resolved at the top of makeDecision().
    // It's available in this scope for the switchThreshold + reliability check.

    if (activeSession && activeSession.state === "ACTIVE") {
      // Active session — evaluate KEEP vs SWITCH using the PERSISTED health
      // snapshot (Phase 8.6). Health is derived from the measurement stream
      // by deriveResourceHealth() at ingestion time — not recomputed here.
      // This makes hysteresis a genuine control-system property.
      //
      // Phase 9.3.2: The switchThreshold uses the EFFECTIVE policy, not a
      // caller-supplied policy. The escape hatch is removed.
      const switchThreshold = effectivePolicy.switchHysteresis;

      // Control-system gates: dwell + cooldown (unchanged)
      const MIN_DWELL_MS = 60_000;
      const COOLDOWN_MS = 120_000;
      const MIN_SAMPLES_FOR_SWITCH = 3; // need at least 3 samples for switch confidence

      // Dwell check
      if (activeSession.startedAt && Date.now() - activeSession.startedAt.getTime() < MIN_DWELL_MS) {
        action = "KEEP";
        reasons.push(`Session started <${MIN_DWELL_MS / 1000}s ago — dwell time not met`);
        constraintsSatisfied.push("DWELL_TIME_ENFORCED");
      } else {
        // Cooldown check
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
        } else if (!activeSession.activeResourceId) {
          action = "KEEP";
          reasons.push("Active session has no activeResourceId — nothing to switch from");
          constraintsViolated.push("NO_ACTIVE_RESOURCE");
        } else {
          // Phase 8.6: consult the PERSISTED ResourceHealth snapshot.
          const health = await getResourceHealth(activeSession.activeResourceId);

          if (!health) {
            action = "KEEP";
            reasons.push("No persisted health snapshot for active resource — insufficient observation");
            constraintsSatisfied.push("HEALTH_UNKNOWN");
          } else if (health.status === "DEGRADED") {
            // Freshness gating: a stale/expired health snapshot must NOT
            // trigger an automatic switch as though it were current.
            if (!mayTriggerAutomaticSwitch(health.freshness)) {
              action = "KEEP";
              reasons.push(`Active resource DEGRADED but health freshness is ${health.freshness} — will not auto-switch on stale observation`);
              constraintsSatisfied.push("FRESHNESS_GATE_ENFORCED");
              constraintsViolated.push("STALE_HEALTH");
            } else if (health.sampleCount < MIN_SAMPLES_FOR_SWITCH) {
              action = "KEEP";
              reasons.push(`Only ${health.sampleCount} sample(s) — need ${MIN_SAMPLES_FOR_SWITCH} for switch confidence`);
              constraintsSatisfied.push("CONFIDENCE_THRESHOLD_ENFORCED");
            } else if (score - health.quality > switchThreshold) {
              action = "SWITCH";
              reasons.push(`Active resource DEGRADED (quality ${health.quality.toFixed(2)}, ${health.degradedCount}/${health.sampleCount} samples degraded) — improvement to candidate ${score.toFixed(2)} exceeds threshold ${switchThreshold}`);
              constraintsSatisfied.push("SWITCH_THRESHOLD_MET");
              constraintsSatisfied.push("M_OF_N_DEGRADED");
              constraintsSatisfied.push("HYSTERESIS_PASSED");
              constraintsSatisfied.push("HEALTH_FRESH");
            } else {
              action = "KEEP";
              reasons.push(`Degraded but improvement ${score.toFixed(2)} - ${health.quality.toFixed(2)} < threshold ${switchThreshold}`);
              constraintsSatisfied.push("QUALITY_ACCEPTABLE");
            }
          } else {
            // HEALTHY or UNKNOWN → keep
            action = "KEEP";
            reasons.push(`Active resource health is ${health.status} (quality ${health.quality.toFixed(2)}) — no switch needed`);
            constraintsSatisfied.push("QUALITY_ACCEPTABLE");
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

  // Step 6: Reliability check (uses effective policy)
  if (effectivePolicy.minReliability && bestCapability) {
    if (bestCapability.reliability >= effectivePolicy.minReliability) {
      constraintsSatisfied.push("MEETS_RELIABILITY");
    } else {
      constraintsViolated.push("BELOW_MIN_RELIABILITY");
    }
  }

  // Step 7: Policy evaluation (effective policy already resolved in Step 4)
  // Phase 9.3.2: No caller-supplied escape hatch. The effectivePolicy was
  // derived from base policy + device context in Step 4.
  const policyResult = evaluatePolicy({
    policy: effectivePolicy,
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

  // Step 8: Persist with provenance (Phase 9.3.2 + 9.4)
  const decision = await db.connectivityDecision.create({
    data: {
      intentId: input.intentId ?? "unknown",
      // Phase 9.4: Intent version provenance
      intentVersion: input.intentVersion ?? null,
      sessionId: input.sessionId ?? null,
      action,
      targetResourceId: targetResourceId ?? null,
      targetOfferId: targetOfferId ?? null,
      score,
      // Phase 9.4: Structured reason codes (deterministic, evidence-backed)
      constraintsSatisfied: JSON.stringify(constraintsSatisfied),
      constraintsViolated: JSON.stringify(constraintsViolated),
      reasons: JSON.stringify(reasons),
      policyVersion: effectivePolicy.basePolicyId ?? "default", // LEGACY: holds policyId, not version. New consumers use basePolicyId/basePolicyVersion.
      // Phase 9.3.2: Durable provenance
      basePolicyId: effectivePolicy.basePolicyId,
      basePolicyVersion: effectivePolicy.basePolicyVersion,
      basePreset: effectivePolicy.basePreset,
      contextDeviceId: effectivePolicy.contextDeviceId,
      contextVersion: effectivePolicy.contextVersion,
      contextObservedAt: effectivePolicy.contextObservedAt,
      effectivePreset: effectivePolicy.effectivePreset,
      derivationReasons: effectivePolicy.derivationReason ?? null,
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
