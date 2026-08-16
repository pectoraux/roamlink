/**
 * Phase 9.3 — Policy Context Service (mobile)
 *
 * Collects device context (battery saver, metered, roaming) automatically
 * and sends user-configured preferences to the server. The server-side policy
 * engine remains authoritative — the mobile NEVER decides.
 *
 *   Mobile context → EdgePolicyContext → Server policy engine → Decision → Action
 *
 * NOT: Mobile context → mobile decides "switch to Wi-Fi"
 */

import { api, getSession } from "../api";
import { getDeviceId, getDeviceContext } from "./device-context";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Auto-detect device context → policy hints
// ---------------------------------------------------------------------------

/**
 * Automatically detect device-level context that informs policy:
 *   - batterySaver (from expo-battery isLowPowerModeEnabledAsync)
 *   - metered (from expo-network isConnectionExpensive)
 *
 * This is CONTEXT, not a decision. The server maps it to a policy preset.
 */
export async function detectDevicePolicyContext(): Promise<Partial<EdgePolicyContext>> {
  const ctx = await getDeviceContext();
  return {
    batterySaver: ctx.powerSaver ?? false,
  };
}

// ---------------------------------------------------------------------------
// User preferences (read/write to server)
// ---------------------------------------------------------------------------

/**
 * Send the user's policy context to the server. The server applies it to
 * the policy engine. The mobile NEVER makes decisions — it only reports
 * context + preferences.
 */
export async function sendPolicyContext(context: EdgePolicyContext): Promise<void> {
  const token = await getSession();
  if (!token) return;

  const deviceId = await getDeviceId();
  try {
    await api.updateEdgePolicyContext(token, deviceId, context);
  } catch (err) {
    console.warn("[policy-context] update failed:", err);
  }
}

/**
 * Read the current policy context from the server (for the settings UI).
 * Returns the last-sent context + the server-applied policy.
 */
export async function fetchPolicyContext(): Promise<{
  context: EdgePolicyContext;
  policy: {
    mode: string;
    preset: string | null;
    maxAutoSpendMinor: number;
    minReliability: number;
    switchHysteresis: number;
    preferredTransports: string[];
    requireUserApprovalForPurchase: boolean;
    neverInterruptActiveCall: boolean;
  } | null;
} | null> {
  const token = await getSession();
  if (!token) return null;

  const deviceId = await getDeviceId();
  try {
    const result = await api.getEdgePolicyContext(token, deviceId);
    return { context: result.context, policy: result.policy };
  } catch (err) {
    console.warn("[policy-context] fetch failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Combined: auto-detect + user preferences → send to server
// ---------------------------------------------------------------------------

/**
 * Merge auto-detected device context with user preferences and send to the
 * server. Called periodically (on app focus, on settings change).
 *
 * The user preferences take precedence over auto-detected ones where they
 * overlap (e.g. user can override batterySaver with a manual preference).
 */
export async function syncPolicyContext(userPreferences: Partial<EdgePolicyContext>): Promise<void> {
  const detected = await detectDevicePolicyContext();
  const merged: EdgePolicyContext = {
    // Auto-detected (device truth)
    batterySaver: userPreferences.batterySaver ?? detected.batterySaver,
    // User-configured (user truth)
    connectivityPreference: userPreferences.connectivityPreference,
    workMode: userPreferences.workMode,
    avoidCellular: userPreferences.avoidCellular,
    allowRoaming: userPreferences.allowRoaming,
    autoSwitchEnabled: userPreferences.autoSwitchEnabled,
  };

  await sendPolicyContext(merged);
}
