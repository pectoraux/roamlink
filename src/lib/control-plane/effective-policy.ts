/**
 * Control Plane — Effective Policy Derivation (Phase 9.3.1)
 *
 * Derives the EFFECTIVE policy from:
 *   BASE POLICY (user's authoritative choice — preset, mode, autoSwitch)
 *     + DEVICE CONTEXT (transient — batterySaver, roaming, metered, workMode)
 *
 * The device context does NOT overwrite the base policy. It modifies the
 * effective policy for the current decision only. This prevents a phone
 * reporting batterySaver=true from permanently mutating the user's global
 * policy (which would affect the user's laptop too).
 *
 *   Base policy = RELIABLE
 *   + Device batterySaver = true
 *   → Effective policy = BATTERY (for this decision)
 *
 *   Base policy = RELIABLE  (unchanged on disk)
 *
 * The decision engine reads the effective policy, not the base policy.
 *
 * Explicit user overrides (autoSwitchEnabled=false, connectivityPreference)
 * ARE written to the base policy — they are user decisions, not transient
 * device context.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getPolicy, POLICY_PRESETS, type PolicyEvaluation } from "./policy-engine";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EffectivePolicy = PolicyEvaluation & {
  /** The base policy preset the user chose (unchanged by device context). */
  basePreset: string | null;
  /** The effective preset after applying device context. May differ from base. */
  effectivePreset: string;
  /** The device context that modified the base policy (if any). */
  appliedDeviceContext: EdgePolicyContext | null;
  /** Why the effective preset differs from the base (if it does). */
  derivationReason?: string;
};

// ---------------------------------------------------------------------------
// Derive effective policy
// ---------------------------------------------------------------------------

/**
 * Derive the effective policy for a user by combining their base policy
 * with their device's current context.
 *
 * The base policy is read from the ConnectivityPolicy table (authoritative).
 * The device context is read from EdgeDevice.policyContext (transient snapshot).
 *
 * Device context can DOWNGRADE the effective policy (e.g. RELIABLE → BATTERY
 * when batterySaver is true) but never UPGRADE it (CHEAPEST doesn't become
 * RELIABLE just because workMode is on — the user must explicitly choose
 * RELIABLE as their base preset).
 *
 * @param subjectId The user ID (base policy owner)
 * @param deviceId The device ID (context source). If null, no device context
 *                 is applied (base policy is used as-is).
 */
export async function deriveEffectivePolicy(
  subjectId: string,
  deviceId?: string,
): Promise<EffectivePolicy> {
  // 1. Read the base policy (authoritative — user's explicit choice)
  const basePolicy = await getPolicy(subjectId);

  // 2. Read the device context (transient snapshot)
  let deviceContext: EdgePolicyContext | null = null;
  if (deviceId) {
    const device = await db.edgeDevice.findUnique({
      where: { deviceId },
      select: { policyContext: true, userId: true },
    });

    if (device && device.userId === subjectId && device.policyContext) {
      try {
        deviceContext = JSON.parse(device.policyContext) as EdgePolicyContext;
      } catch {
        // Corrupt context — ignore it
      }
    }
  }

  // 3. Derive the effective preset
  // The base preset comes from the policy record. If the policy was created
  // via a preset, we can detect it from the parameters. Otherwise, we use
  // the base policy's mode + parameters as-is.
  const basePreset = detectBasePreset(basePolicy);
  let effectivePreset = basePreset ?? "MANUAL";
  let derivationReason: string | undefined;

  if (deviceContext) {
    // Device context can DOWNGRADE the effective policy:
    // - batterySaver → BATTERY (regardless of base — battery conservation
    //   is a physical constraint, not a preference)
    // - workMode → WORK (if base allows it — not if base is CHEAPEST, since
    //   the user explicitly chose cost over quality)
    //
    // Device context CANNOT UPGRADE:
    // - If base is CHEAPEST, workMode does NOT make it WORK (user chose cheap)
    // - If base is BATTERY, nothing upgrades it (battery is the floor)

    if (deviceContext.batterySaver) {
      // Battery saver always wins — it's a physical constraint
      if (effectivePreset !== "BATTERY") {
        effectivePreset = "BATTERY";
        derivationReason = "Device batterySaver=true → effective BATTERY";
      }
    } else if (deviceContext.workMode && basePreset !== "CHEAPEST" && basePreset !== "BATTERY") {
      // Work mode applies if the base policy isn't already cost/battery constrained
      if (effectivePreset !== "WORK") {
        effectivePreset = "WORK";
        derivationReason = "Device workMode=true → effective WORK";
      }
    }
  }

  // 4. Build the effective policy parameters
  // Start with the base policy, then overlay the effective preset's parameters
  // if the effective preset differs from the base.
  let effectiveParams: PolicyEvaluation = basePolicy;

  if (effectivePreset !== basePreset && POLICY_PRESETS[effectivePreset as keyof typeof POLICY_PRESETS]) {
    const presetParams = POLICY_PRESETS[effectivePreset as keyof typeof POLICY_PRESETS];
    // Merge: preset parameters override base, but keep the user's explicit
    // maxAutoSpendMinor (they may have set a custom spend limit).
    effectiveParams = {
      ...basePolicy,
      ...presetParams,
      maxAutoSpendMinor: basePolicy.maxAutoSpendMinor, // preserve user's spend limit
      id: basePolicy.id,
      subjectId: basePolicy.subjectId,
      isDefault: basePolicy.isDefault,
    };
  }

  // 5. Apply device-context-specific transport preferences
  // avoidCellular restricts transports to WIFI only (for this decision)
  if (deviceContext?.avoidCellular) {
    effectiveParams = {
      ...effectiveParams,
      preferredTransports: ["WIFI"],
    };
    if (!derivationReason) {
      derivationReason = "Device avoidCellular=true → preferredTransports=['WIFI']";
    }
  }

  if (derivationReason) {
    logger.info("effective_policy.derived", {
      subjectId, deviceId, basePreset, effectivePreset, reason: derivationReason,
    });
  }

  return {
    ...effectiveParams,
    basePreset,
    effectivePreset,
    appliedDeviceContext: deviceContext,
    derivationReason,
  };
}

// ---------------------------------------------------------------------------
// Detect the base preset from policy parameters
// ---------------------------------------------------------------------------

/**
 * Detect which preset the base policy matches (by comparing parameters).
 * Returns null if the policy doesn't match any preset (custom policy).
 *
 * Note: maxAutoSpendMinor is NOT compared — it's user-customizable and
 * doesn't determine the preset.
 */
function detectBasePreset(policy: PolicyEvaluation): string | null {
  for (const [name, preset] of Object.entries(POLICY_PRESETS)) {
    if (
      policy.mode === preset.mode &&
      policy.minReliability === preset.minReliability &&
      policy.switchHysteresis === preset.switchHysteresis &&
      policy.requireUserApprovalForPurchase === preset.requireUserApprovalForPurchase &&
      policy.neverInterruptActiveCall === preset.neverInterruptActiveCall &&
      JSON.stringify(policy.preferredTransports) === JSON.stringify(preset.preferredTransports)
    ) {
      return name;
    }
  }
  return null;
}
