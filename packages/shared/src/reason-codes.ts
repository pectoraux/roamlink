/**
 * Phase 9.5.4 — Canonical Decision Reason-Code Protocol Contract
 *
 * ReasonCode is the single source of truth for machine-readable decision
 * evidence. It is a versioned protocol contract, not a TypeScript
 * implementation detail.
 *
 *   reasonCodes[] = protocol evidence (canonical, machine-readable)
 *   reasons[]     = human-readable projection (presentation text)
 *
 * A producer may never emit an unregistered code.
 * A consumer may ignore an unknown future reason code only at a declared
 * compatibility boundary.
 */

// ---------------------------------------------------------------------------
// Canonical Reason-Code Registry
// ---------------------------------------------------------------------------

/**
 * The canonical set of decision reason codes. Each code corresponds to
 * actual decision logic in the decision engine — no free-form explanations.
 *
 * Adding a code requires: protocol registry update + tests.
 * Renaming/removing a code is a protocol change.
 */
export const REASON_CODES = [
  "RELIABILITY_REQUIREMENT",   // minReliability gate
  "BATTERY_SAVER_CONTEXT",     // effective policy derivation (BATTERY_SAVER_RULE)
  "BUDGET_CONSTRAINT",         // budget gate (WITHIN_BUDGET or OVER_BUDGET)
  "FRESHNESS_GATE",            // stale health → no auto-switch
  "RESOURCE_UNAVAILABLE",      // no available resources found
  "PREFERRED_TRANSPORT",       // transport preference applied
  "POLICY_CONSTRAINT",         // policy blocked or allowed
  "ACTIVE_SESSION",            // session already active / resource selected
  "HYSTERESIS",                // M-of-N degraded + improvement margin
  "NO_BETTER_RESOURCE",        // best candidate not better than current
  "DWELL_TIME",                // session too young to switch
  "COOLDOWN",                  // recent switch, cooling down
  "INSUFFICIENT_SAMPLES",      // not enough measurements for confidence
  "INTENT_EXPIRED",            // intent expired/superseded, no new action
  "INTENT_SUPERSEDED",         // intent was superseded, no new action
  "QUALITY_ACCEPTABLE",        // current resource is healthy enough
] as const;

// ---------------------------------------------------------------------------
// Type + Schema
// ---------------------------------------------------------------------------

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Check if a string is a valid canonical reason code.
 */
export function isValidReasonCode(code: string): code is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(code);
}

/**
 * Validate an array of reason codes. Returns the validated array if all
 * codes are valid, or throws if any code is unknown.
 *
 * Used at the persistence boundary to fail closed on unknown codes.
 */
export function validateReasonCodes(codes: unknown): ReasonCode[] {
  if (!Array.isArray(codes)) {
    throw new Error(`reasonCodes must be an array, got ${typeof codes}`);
  }
  for (const code of codes) {
    if (typeof code !== "string" || !isValidReasonCode(code)) {
      throw new Error(`Unknown reason code: "${code}". Valid codes: ${REASON_CODES.join(", ")}`);
    }
  }
  return codes as ReasonCode[];
}

/**
 * Parse a JSON string of reason codes, validating each against the canonical
 * registry. Used at read/API boundaries where JSON is deserialized.
 *
 * Returns an empty array if the input is null/undefined/malformed (fail-safe
 * for read models — the decision existed before reason codes were mandatory).
 */
export function parseReasonCodes(json: string | null | undefined): ReasonCode[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return validateReasonCodes(parsed);
  } catch {
    // Malformed JSON — fail safe (empty array, not an error)
    // The persistence boundary should have prevented this; read models
    // should not crash on corrupt data.
    return [];
  }
}

/**
 * Serialize reason codes for persistence (JSON string).
 * Validates before serializing — invalid codes are rejected.
 */
export function serializeReasonCodes(codes: ReasonCode[]): string {
  return JSON.stringify(validateReasonCodes(codes));
}
