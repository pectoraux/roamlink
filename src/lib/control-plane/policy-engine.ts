/**
 * Control Plane — Policy Engine
 *
 * Manages ConnectivityPolicy records — the deterministic rules that govern
 * autonomous decisions. Policies answer questions like:
 *
 *   - Can RoamLink switch automatically?
 *   - Can it spend money automatically?
 *   - Maximum autonomous spend?
 *   - Minimum quality threshold?
 *   - Prefer WiFi? Prefer cellular?
 *   - Never interrupt an active video call?
 *
 * Policies are ALWAYS deterministic. AI never decides these things.
 * The policy engine creates, updates, and evaluates policies.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Preset Policy Templates
// ---------------------------------------------------------------------------

export const POLICY_PRESETS = {
  CHEAPEST: {
    mode: "automatic" as const,
    maxAutoSpendMinor: 500,
    preferredTransports: ["WIFI", "CELLULAR"],
    minReliability: 0.3,
    switchHysteresis: 0.05, // easy to switch for price
    requireUserApprovalForPurchase: false,
    neverInterruptActiveCall: false,
  },
  RELIABLE: {
    mode: "automatic" as const,
    maxAutoSpendMinor: 2000,
    preferredTransports: ["CELLULAR", "WIFI"],
    minReliability: 0.95,
    switchHysteresis: 0.2, // harder to switch — only for big quality gains
    requireUserApprovalForPurchase: true,
    neverInterruptActiveCall: true,
  },
  WORK: {
    mode: "automatic" as const,
    maxAutoSpendMinor: 1000,
    preferredTransports: ["WIFI", "CELLULAR"],
    minReliability: 0.9,
    switchHysteresis: 0.15,
    requireUserApprovalForPurchase: true,
    neverInterruptActiveCall: true,
  },
  BATTERY: {
    mode: "automatic" as const,
    maxAutoSpendMinor: 300,
    preferredTransports: ["WIFI"], // WiFi uses less battery than cellular
    minReliability: 0.5,
    switchHysteresis: 0.25, // rarely switch to save battery
    requireUserApprovalForPurchase: false,
    neverInterruptActiveCall: false,
  },
  UNLIMITED: {
    mode: "automatic" as const,
    maxAutoSpendMinor: 10000, // high spend limit
    preferredTransports: ["WIFI", "CELLULAR"],
    minReliability: 0.8,
    switchHysteresis: 0.1,
    requireUserApprovalForPurchase: false,
    neverInterruptActiveCall: true,
  },
  MANUAL: {
    mode: "manual" as const,
    maxAutoSpendMinor: 0,
    preferredTransports: [],
    minReliability: 0.5,
    switchHysteresis: 0.15,
    requireUserApprovalForPurchase: true,
    neverInterruptActiveCall: true,
  },
};

// ---------------------------------------------------------------------------
// Create / Update Policy
// ---------------------------------------------------------------------------

export async function createOrUpdatePolicy(input: {
  subjectId: string;
  preset?: keyof typeof POLICY_PRESETS;
  mode?: "automatic" | "manual";
  maxAutoSpendMinor?: number;
  preferredTransports?: string[];
  minReliability?: number;
  switchHysteresis?: number;
  requireUserApprovalForPurchase?: boolean;
  neverInterruptActiveCall?: boolean;
}): Promise<{ policyId: string }> {
  // Check for existing policy
  const existing = await db.connectivityPolicy.findFirst({
    where: { subjectId: input.subjectId },
  });

  // Phase 9.3.1: When no preset is provided, preserve existing values
  // instead of defaulting to MANUAL. This prevents a mode-only update
  // (e.g. autoSwitchEnabled=true → mode=automatic) from overwriting the
  // user's chosen preset parameters.
  const preset = input.preset ? POLICY_PRESETS[input.preset] : null;

  // Build the base values: preset > existing > MANUAL
  const existingParsed = existing ? {
    mode: existing.mode as "automatic" | "manual",
    maxAutoSpendMinor: existing.maxAutoSpendMinor,
    preferredTransports: existing.preferredTransports ? JSON.parse(existing.preferredTransports) : [],
    minReliability: existing.minReliability,
    switchHysteresis: existing.switchHysteresis,
    requireUserApprovalForPurchase: existing.requireUserApprovalForPurchase,
    neverInterruptActiveCall: existing.neverInterruptActiveCall,
    preset: existing.preset,
  } : null;
  const base = preset ?? existingParsed ?? POLICY_PRESETS.MANUAL;

  // Phase 9.3.2: Store the preset explicitly. If a preset is provided,
  // use it. If not, preserve the existing preset. Only fall back to null
  // (custom) if there's no existing preset and no input preset.
  const storedPreset = input.preset ?? existingParsed?.preset ?? null;

  // Phase 9.3.2: Increment version on update for provenance tracking
  const newVersion = existing ? (existing.version ?? 1) + 1 : 1;

  const data = {
    subjectId: input.subjectId,
    mode: input.mode ?? base.mode,
    maxAutoSpendMinor: input.maxAutoSpendMinor ?? base.maxAutoSpendMinor,
    preferredTransports: JSON.stringify(input.preferredTransports ?? base.preferredTransports),
    minReliability: input.minReliability ?? base.minReliability,
    switchHysteresis: input.switchHysteresis ?? base.switchHysteresis,
    requireUserApprovalForPurchase: input.requireUserApprovalForPurchase ?? base.requireUserApprovalForPurchase,
    neverInterruptActiveCall: input.neverInterruptActiveCall ?? base.neverInterruptActiveCall,
    preset: storedPreset,
    version: newVersion,
  };

  let policy;
  if (existing) {
    policy = await db.connectivityPolicy.update({
      where: { id: existing.id },
      data,
    });
  } else {
    policy = await db.connectivityPolicy.create({ data });
  }

  logger.info("policy.set", {
    policyId: policy.id,
    subjectId: input.subjectId,
    mode: data.mode,
    preset: input.preset ?? "custom",
  });

  return { policyId: policy.id };
}

// ---------------------------------------------------------------------------
// Get Policy
// ---------------------------------------------------------------------------

export async function getPolicy(subjectId: string) {
  const policy = await db.connectivityPolicy.findFirst({
    where: { subjectId },
  });

  if (!policy) {
    // Return default policy (MANUAL)
    return {
      id: null,
      subjectId,
      mode: "manual" as const,
      maxAutoSpendMinor: 0,
      preferredTransports: [],
      minReliability: 0.5,
      switchHysteresis: 0.15,
      requireUserApprovalForPurchase: true,
      neverInterruptActiveCall: true,
      preset: null,
      version: 0,
      isDefault: true,
    };
  }

  return {
    id: policy.id,
    subjectId: policy.subjectId,
    mode: policy.mode as "automatic" | "manual",
    maxAutoSpendMinor: policy.maxAutoSpendMinor,
    preferredTransports: policy.preferredTransports ? JSON.parse(policy.preferredTransports) : [],
    minReliability: policy.minReliability,
    switchHysteresis: policy.switchHysteresis,
    requireUserApprovalForPurchase: policy.requireUserApprovalForPurchase,
    neverInterruptActiveCall: policy.neverInterruptActiveCall,
    preset: policy.preset,
    version: policy.version ?? 1,
    isDefault: false,
  };
}

// ---------------------------------------------------------------------------
// Evaluate Policy — can an action proceed automatically?
// ---------------------------------------------------------------------------

export type PolicyEvaluation = {
  allowed: boolean;
  reason: string;
  requiresUserApproval: boolean;
};

/**
 * Evaluate whether a proposed action is allowed by the user's policy.
 *
 * This is called by the decision engine before creating an action. If the
 * policy doesn't allow the action, the decision engine returns ASK_USER
 * instead of proceeding.
 */
export function evaluatePolicy(input: {
  policy: Awaited<ReturnType<typeof getPolicy>>;
  action: "SWITCH" | "ACTIVATE" | "PURCHASE";
  estimatedCostMinor?: number;
  hasActiveCall?: boolean;
}): PolicyEvaluation {
  const { policy, action, estimatedCostMinor, hasActiveCall } = input;

  // Manual mode — nothing is automatic
  if (policy.mode === "manual") {
    return {
      allowed: false,
      reason: "Policy is manual — user approval required for all actions",
      requiresUserApproval: true,
    };
  }

  // Check active call constraint
  if (hasActiveCall && policy.neverInterruptActiveCall && action === "SWITCH") {
    return {
      allowed: false,
      reason: "Active call detected — policy prevents switching during calls",
      requiresUserApproval: true,
    };
  }

  // Check spend limit for purchases
  if (action === "PURCHASE" || action === "ACTIVATE") {
    const cost = estimatedCostMinor ?? 0;

    if (cost > policy.maxAutoSpendMinor) {
      return {
        allowed: false,
        reason: `Cost ${cost} exceeds max auto-spend ${policy.maxAutoSpendMinor}`,
        requiresUserApproval: true,
      };
    }

    if (policy.requireUserApprovalForPurchase && action === "PURCHASE") {
      return {
        allowed: false,
        reason: "Policy requires user approval for purchases",
        requiresUserApproval: true,
      };
    }
  }

  // All checks passed
  return {
    allowed: true,
    reason: "Action allowed by policy",
    requiresUserApproval: false,
  };
}
