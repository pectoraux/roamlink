/**
 * Control Plane — Measurement Freshness (Phase 8.6.2)
 *
 * The decision engine must reject stale measurements. Freshness is computed
 * from `capturedAt` at ingestion time and persisted, so a historical
 * measurement stays historical.
 *
 *   FRESH    age < 30s    — may trigger automatic decisions
 *   STALE    30s–120s     — informs health, must NOT be the sole switch trigger
 *   EXPIRED  > 120s       — excluded from health derivation entirely
 *   UNKNOWN                 capturedAt missing / not computed
 *
 * Thresholds are policy-overridable. A stale measurement must not trigger an
 * automatic switch as though it were current.
 */

import type { MeasurementFreshness } from "@/lib/protocol";

// ---------------------------------------------------------------------------
// Default thresholds (policy-overridable)
// ---------------------------------------------------------------------------

export const DEFAULT_FRESH_MS = 30_000; // < 30s → FRESH
export const DEFAULT_STALE_MS = 120_000; // 30s–120s → STALE; > 120s → EXPIRED

export type FreshnessThresholds = {
  freshMs: number;
  staleMs: number;
};

export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  freshMs: DEFAULT_FRESH_MS,
  staleMs: DEFAULT_STALE_MS,
};

// ---------------------------------------------------------------------------
// Classify freshness from a capture timestamp
// ---------------------------------------------------------------------------

/**
 * Classify the freshness of a measurement given its capture time.
 *
 * @param capturedAt When the measurement was observed.
 * @param now        The reference "now" (defaults to Date.now()).
 * @param thresholds Policy-overridable thresholds.
 * @returns FRESH | STALE | EXPIRED | UNKNOWN
 */
export function classifyFreshness(
  capturedAt: Date | string | null | undefined,
  now: Date | number = Date.now(),
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): MeasurementFreshness {
  if (!capturedAt) return "UNKNOWN";

  const capturedMs = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
  if (Number.isNaN(capturedMs)) return "UNKNOWN";

  const nowMs = now instanceof Date ? now.getTime() : now;
  const ageMs = nowMs - capturedMs;

  if (ageMs < 0) {
    // captured in the future — treat as FRESH (clock skew tolerance)
    return "FRESH";
  }
  if (ageMs < thresholds.freshMs) return "FRESH";
  if (ageMs < thresholds.staleMs) return "STALE";
  return "EXPIRED";
}

// ---------------------------------------------------------------------------
// Freshness gating for decisions
// ---------------------------------------------------------------------------

/**
 * Whether a measurement of this freshness may be used as the sole trigger
 * for an automatic switch.
 *
 * FRESH  → yes
 * STALE  → no (may inform health, but cannot be the sole trigger)
 * EXPIRED→ no (excluded from health derivation entirely)
 * UNKNOWN→ no
 */
export function mayTriggerAutomaticSwitch(freshness: MeasurementFreshness): boolean {
  return freshness === "FRESH";
}

/**
 * Whether a measurement of this freshness contributes to health derivation.
 *
 * FRESH + STALE contribute. EXPIRED + UNKNOWN do not.
 */
export function contributesToHealth(freshness: MeasurementFreshness): boolean {
  return freshness === "FRESH" || freshness === "STALE";
}
