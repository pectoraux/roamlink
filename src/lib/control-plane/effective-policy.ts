/**
 * Control Plane — Effective Policy Derivation (Phase 9.3.1 + 9.3.2)
 *
 * Derives the EFFECTIVE policy from:
 *   BASE POLICY (user's authoritative choice — preset, mode, autoSwitch)
 *     + DEVICE CONTEXT (transient — batterySaver, roaming, metered, workMode)
 *
 * Phase 9.3.2 changes:
 *   - Policy identity is first-class: uses the stored `preset` field, not
 *     reverse-engineered via detectBasePreset(). A policy created from RELIABLE
 *     carries preset="RELIABLE" even if the user later customizes parameters.
 *   - batterySaver is a server-defined rule, not a hard-coded physical law.
 *     The BATTERY_RULE controls whether batterySaver context overrides the
 *     base preset. A future policy could disable this rule for critical calls.
 *   - Returns provenance fields (basePolicyId, basePolicyVersion, contextVersion,
 *     contextObservedAt) so the decision engine can persist them.
 *
 * The device context does NOT overwrite the base policy. It modifies the
 * effective policy for the current decision only.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getPolicy, POLICY_PRESETS, type PolicyEvaluation } from "./policy-engine";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Phase 9.3.2: Server-defined rules for context → preset derivation
// ---------------------------------------------------------------------------

/**
 * Controls whether batterySaver context overrides the base preset.
 *
 * Phase 9.3.2: This is a server-defined deterministic rule, not a physical law.
 * A future policy could set `batterySaverOverridesBase = false` to maintain
 * reliable connectivity for a critical call even in battery saver mode.
 *
 * Default: true (battery conservation is the default behavior).
 */
export const BATTERY_SAVER_RULE = {
  overridesBase: true, // batterySaver → BATTERY by default
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EffectivePolicy = PolicyEvaluation & {
  /** The base policy preset the user chose (from the stored field). */
  basePreset: string | null;
  /** The effective preset after applying device context. May differ from base. */
  effectivePreset: string;
  /** The device context that modified the base policy (if any). */
  appliedDeviceContext: EdgePolicyContext | null;
  /** Why the effective preset differs from the base (if it does). */
  derivationReason?: string;
  // Phase 9.3.2: Provenance fields for durable decision audit
  basePolicyId: string | null;
  basePolicyVersion: number;
  contextDeviceId: string | null;
  contextVersion: number | null;
  contextObservedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Derive effective policy
// ---------------------------------------------------------------------------

export async function deriveEffectivePolicy(
  subjectId: string,
  deviceId?: string,
): Promise<EffectivePolicy> {
  // 1. Read the base policy (authoritative — user's explicit choice)
  const basePolicy = await getPolicy(subjectId);

  // Phase 9.3.2: Use the stored preset field (first-class identity), not
  // reverse-engineered detection. If preset is null, it's a custom policy.
  const basePreset = basePolicy.preset ?? null;

  // 2. Read the device context (transient snapshot)
  let deviceContext: EdgePolicyContext | null = null;
  let contextVersion: number | null = null;
  let contextObservedAt: Date | null = null;

  if (deviceId) {
    const device = await db.edgeDevice.findUnique({
      where: { deviceId },
      select: {
        policyContext: true,
        userId: true,
        policyContextVersion: true,
        policyContextObservedAt: true,
      },
    });

    if (device && device.userId === subjectId && device.policyContext) {
      try {
        deviceContext = JSON.parse(device.policyContext) as EdgePolicyContext;
        contextVersion = device.policyContextVersion ?? null;
        contextObservedAt = device.policyContextObservedAt ?? null;
      } catch {
        // Corrupt context — ignore it
      }
    }
  }

  // 3. Derive the effective preset
  let effectivePreset = basePreset ?? "MANUAL";
  let derivationReason: string | undefined;

  if (deviceContext) {
    // Phase 9.3.2: batterySaver is a server-defined rule, not a hard-coded law.
    // The BATTERY_SAVER_RULE controls whether it overrides the base preset.
    if (deviceContext.batterySaver && BATTERY_SAVER_RULE.overridesBase) {
      if (effectivePreset !== "BATTERY") {
        effectivePreset = "BATTERY";
        derivationReason = "Device batterySaver=true → effective BATTERY (server rule: batterySaverOverridesBase=true)";
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
  let effectiveParams: PolicyEvaluation = basePolicy;

  if (effectivePreset !== basePreset && POLICY_PRESETS[effectivePreset as keyof typeof POLICY_PRESETS]) {
    const presetParams = POLICY_PRESETS[effectivePreset as keyof typeof POLICY_PRESETS];
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
      basePolicyId: basePolicy.id, basePolicyVersion: basePolicy.version,
      contextVersion, contextObservedAt: contextObservedAt?.toISOString(),
    });
  }

  return {
    ...effectiveParams,
    basePreset,
    effectivePreset,
    appliedDeviceContext: deviceContext,
    derivationReason,
    basePolicyId: basePolicy.id,
    basePolicyVersion: basePolicy.version,
    contextDeviceId: deviceId ?? null,
    contextVersion,
    contextObservedAt,
  };
}
