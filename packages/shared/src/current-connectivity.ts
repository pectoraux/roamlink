/**
 * Phase 9.2 — Current Connectivity Read Model
 *
 * A read-only projection of the user's current connectivity state, derived
 * from the existing session/resource/health/decision projections.
 *
 * The mobile UI consumes this to show "what connectivity is serving the user
 * now, why it is considered healthy/degraded, and what RoamLink is currently
 * optimizing" — WITHOUT giving the UI control-plane authority.
 *
 * The UI must NOT contain "Switch provider", "Activate eSIM", or any
 * provider-specific commands. It reports state; the server remains authoritative.
 */

// ---------------------------------------------------------------------------
// CurrentConnectivity — the full read model
// ---------------------------------------------------------------------------

export type CurrentConnectivity = {
  /** The active connectivity session (or null if no active connectivity). */
  session: CurrentConnectivitySession | null;
  /** The capability/type of the active resource (INTERNET, ROAMING, etc.). */
  capability: CurrentConnectivityCapability | null;
  /** The health snapshot of the active resource. */
  health: CurrentConnectivityHealth | null;
  /** The most recent decision (what RoamLink is doing/optimizing). */
  decision: CurrentConnectivityDecision | null;
  /** Any ongoing transition (switch in progress, etc.). */
  transition: CurrentConnectivityTransition | null;
  /** Server timestamp for clock sync. */
  serverTime: string;
};

export type CurrentConnectivitySession = {
  id: string;
  state: "PLANNED" | "DISCOVERING" | "RESERVED" | "ACTIVE" | "DEGRADED" | "SWITCHING" | "ENDED" | "FAILED";
  activeResourceId: string | null;
  startedAt: string | null;
  lastObservedAt: string | null;
};

export type CurrentConnectivityCapability = {
  type: string; // INTERNET | ROAMING | LOCAL_NETWORK | VPN_ACCESS | MESH_RELAY
  providerType: string; // mikrotik | esim | mock | future
  /** Human-readable label for the transport (WiFi, Cellular, eSIM, ISP). */
  transportLabel: string;
  /** Geographic context if available. */
  location?: { country?: string; city?: string };
};

export type CurrentConnectivityHealth = {
  status: "HEALTHY" | "DEGRADED" | "UNKNOWN";
  qualityScore: number; // 0–1
  reliability: number; // 0–1 (from capability)
  latencyMs?: number;
  packetLossPct?: number;
  bandwidthDownMbps?: number;
  bandwidthUpMbps?: number;
  observedAt: string | null;
  freshness: "FRESH" | "STALE" | "EXPIRED" | "UNKNOWN";
  /** Human-readable explanation of the health status. */
  explanation: string;
  /** Phase 10: Trust level of the evidence behind this health snapshot.
   * Orthogonal to status/freshness. TRUSTED = provider/server evidence.
   * LIMITED = device evidence only. UNTRUSTED = no eligible evidence. */
  trust: "TRUSTED" | "LIMITED" | "UNTRUSTED";
};

import type { ReasonCode } from "./reason-codes";

export type CurrentConnectivityDecision = {
  /** What RoamLink is doing: KEEP, SWITCH, ACTIVATE, WAIT, ASK_USER. */
  action: string;
  /** Human-readable status: "Optimizing automatically", "Monitoring", etc. */
  statusLabel: string;
  /** Human-readable explanation (projection of reason codes). */
  reasons: string[];
  /** Phase 9.5.4: Canonical machine-readable reason codes (protocol contract). */
  reasonCodes: ReasonCode[];
  createdAt: string | null;
};

export type CurrentConnectivityTransition = {
  state: string; // e.g. "SWITCHING", "RECONCILIATION_REQUIRED"
  startedAt: string | null;
  /** Human-readable description of the transition. */
  description: string;
};
