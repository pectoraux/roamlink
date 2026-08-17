/**
 * Phase 9.5.4 + 9.5.5 — Canonical Decision Reason-Code Protocol Contract
 *
 * ReasonCode is the single source of truth for machine-readable decision
 * evidence. It is a versioned protocol contract, not a TypeScript
 * implementation detail.
 *
 *   reasonCodes[] = protocol evidence (canonical, machine-readable)
 *   reasons[]     = human-readable projection (presentation text)
 *
 * Protocol rules:
 *   Producer: unknown code → MUST NOT persist (fail-closed validation)
 *   Strict server consumer: unknown code → protocol/data-integrity failure
 *   Forward-compatible client: unknown code → MAY ignore, must not reinterpret
 *
 * Phase 9.5.5: Read-boundary integrity semantics. The read path no longer
 * silently filters unknown codes to []. Instead it distinguishes:
 *   ABSENT     — no reasonCodes field (pre-9.5 decision or null)
 *   MALFORMED  — corrupt JSON (should never happen if persistence validated)
 *   UNKNOWN_CODE — a code exists in the DB but not in the current registry
 *   VALID      — all codes are in the canonical registry
 *
 * The strict server consumer (CurrentConnectivity) logs unknown/malformed
 * as data-integrity warnings rather than silently masking them.
 */

// ---------------------------------------------------------------------------
// Canonical Reason-Code Registry
// ---------------------------------------------------------------------------

/**
 * The canonical set of decision reason codes.
 *
 * Registered codes include both currently-emitted codes and reserved codes
 * that are part of the protocol contract but not yet emitted by the decision
 * engine. This distinction is documented per-code below.
 *
 * Adding a code requires: registry update + tests.
 * Renaming/removing a code is a protocol change.
 */
export const REASON_CODES = [
  // --- Currently emitted by decision-engine.ts ---
  "RELIABILITY_REQUIREMENT",   // minReliability gate [EMITTED]
  "BUDGET_CONSTRAINT",         // budget gate (WITHIN_BUDGET or OVER_BUDGET) [EMITTED]
  "FRESHNESS_GATE",            // stale health → no auto-switch [EMITTED]
  "RESOURCE_UNAVAILABLE",      // no available resources found [EMITTED]
  "POLICY_CONSTRAINT",         // policy blocked or allowed [EMITTED]
  "ACTIVE_SESSION",            // session already active / resource selected [EMITTED]
  "HYSTERESIS",                // M-of-N degraded + improvement margin [EMITTED]
  "DWELL_TIME",                // session too young to switch [EMITTED]
  "COOLDOWN",                  // recent switch, cooling down [EMITTED]
  "INSUFFICIENT_SAMPLES",      // not enough measurements for confidence [EMITTED]
  "INTENT_EXPIRED",            // intent expired/superseded, no new action [EMITTED]
  "QUALITY_ACCEPTABLE",        // current resource is healthy enough [EMITTED]

  // --- Reserved (protocol contract, not yet emitted) ---
  "BATTERY_SAVER_CONTEXT",     // effective policy derivation (BATTERY_SAVER_RULE) [RESERVED]
  "PREFERRED_TRANSPORT",       // transport preference applied [RESERVED]
  "NO_BETTER_RESOURCE",        // best candidate not better than current [RESERVED]
  "INTENT_SUPERSEDED",         // intent was superseded, no new action [RESERVED]
] as const;

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Check if a string is a valid canonical reason code.
 */
export function isValidReasonCode(code: string): code is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(code);
}

// ---------------------------------------------------------------------------
// Read-boundary integrity model (Phase 9.5.5)
// ---------------------------------------------------------------------------

/**
 * The integrity status of a reasonCodes field at read time.
 *
 *   ABSENT       — no reasonCodes field (pre-9.5 decision or null)
 *   MALFORMED    — corrupt JSON (should never happen if persistence validated)
 *   UNKNOWN_CODE — a code exists in the DB but not in the current registry
 *   VALID        — all codes are in the canonical registry
 */
export type ReasonCodeIntegrity = "ABSENT" | "MALFORMED" | "UNKNOWN_CODE" | "VALID";

/**
 * The result of parsing reason codes at a read boundary.
 *
 * Includes both the parsed codes (valid subset) and the integrity status,
 * so the consumer can distinguish "no codes" from "corrupt data" from
 * "protocol breach."
 */
export type ParsedReasonCodes = {
  /** The valid reason codes (subset of the registry). */
  codes: ReasonCode[];
  /** Integrity status of the source data. */
  integrity: ReasonCodeIntegrity;
  /** Unknown codes found in the data (for logging/observability). Empty if VALID/ABSENT. */
  unknownCodes: string[];
};

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
 * Parse a JSON string of reason codes with full integrity tracking.
 *
 * Phase 9.5.5: Instead of silently returning [] for corrupt/unknown data,
 * this function returns a ParsedReasonCodes result that distinguishes:
 *   ABSENT — no data
 *   MALFORMED — corrupt JSON
 *   UNKNOWN_CODE — valid JSON array but some codes are not in the registry
 *   VALID — all codes are in the registry
 *
 * The caller decides how to handle each case (log, error, or silently
 * proceed with the valid subset).
 */
export function parseReasonCodesWithIntegrity(json: string | null | undefined): ParsedReasonCodes {
  if (!json) {
    return { codes: [], integrity: "ABSENT", unknownCodes: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { codes: [], integrity: "MALFORMED", unknownCodes: [] };
  }

  if (!Array.isArray(parsed)) {
    return { codes: [], integrity: "MALFORMED", unknownCodes: [] };
  }

  const valid: ReasonCode[] = [];
  const unknown: string[] = [];
  for (const code of parsed) {
    if (typeof code === "string" && isValidReasonCode(code)) {
      valid.push(code);
    } else if (typeof code === "string") {
      unknown.push(code);
    } else {
      // Non-string element — treat as malformed
      return { codes: [], integrity: "MALFORMED", unknownCodes: [] };
    }
  }

  if (unknown.length > 0) {
    return { codes: valid, integrity: "UNKNOWN_CODE", unknownCodes: unknown };
  }

  return { codes: valid, integrity: "VALID", unknownCodes: [] };
}

/**
 * Backward-compatible parse that returns just the codes array.
 * Uses parseReasonCodesWithIntegrity internally but discards the
 * integrity metadata. Used where the caller doesn't need integrity tracking.
 */
export function parseReasonCodes(json: string | null | undefined): ReasonCode[] {
  return parseReasonCodesWithIntegrity(json).codes;
}

/**
 * Serialize reason codes for persistence (JSON string).
 * Validates before serializing — invalid codes are rejected.
 */
export function serializeReasonCodes(codes: ReasonCode[]): string {
  return JSON.stringify(validateReasonCodes(codes));
}
