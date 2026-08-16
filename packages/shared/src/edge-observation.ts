/**
 * Phase 9.1 — Edge Observation Contract
 *
 * The canonical protocol between the mobile agent (edge) and the centralized
 * control plane (server). These types are shared between web and mobile via
 * @roamlink/shared.
 *
 * Architectural constraint (FROZEN):
 *   The mobile agent is an EDGE OBSERVER + POLICY/CONTEXT SOURCE.
 *   It NEVER becomes a second control plane. It does NOT submit precomputed
 *   health scores, decisions, or actions. The server derives authoritative
 *   ConnectivityMeasurement and ResourceHealth from device observations.
 *
 *   Mobile → EdgeObservation → Server → Measurement → Health → Reevaluation → Decision → Action
 *
 * Source provenance is preserved: device observations use source=DEVICE,
 * independent probes use source=PROBE. Provider truth and device truth are
 * never mixed without preserving which is which.
 */

// ---------------------------------------------------------------------------
// 9.1.1 EdgeObservation — the core observation event
// ---------------------------------------------------------------------------

/**
 * A single connectivity observation from a mobile device.
 *
 * The device reports WHAT IT SEES (connectivity state, network, location,
 * device context). It does NOT report what the system should DO.
 *
 * Identity: (deviceId, sequence) is unique per device. The server dedupes
 * on observationId (caller-supplied UUID) AND on (deviceId, sequence).
 */
export type EdgeObservation = {
  /** Caller-supplied UUID — idempotent dedup key. */
  observationId: string;
  /** Stable device identifier (generated once per device, stored locally). */
  deviceId: string;
  /** The control-plane session this observation relates to (optional — the
   * device may not know its session ID). The server validates ownership. */
  sessionId?: string;
  /** The resource the device believes it's using (HINT only — the server
   * validates against the authenticated session's active resource). */
  resourceId?: string;
  /** When the observation was captured on-device (ISO 8601). */
  observedAt: string;
  /** Monotonically increasing per-device sequence number. Lets the server
   * accept out-of-order delivery and detect gaps without treating a missing
   * sequence as fatal. */
  sequence: number;
  /** Provenance: DEVICE (on-device telemetry) or PROBE (synthetic check). */
  source: EdgeObservationSource;
  /** What the device observes about its connectivity. */
  connectivity: EdgeConnectivityState;
  /** Network context. */
  network?: EdgeNetworkContext;
  /** Location context (optional, privacy-minimal — coarse only). */
  location?: EdgeLocationContext;
  /** Device context (battery, power, metered, etc.). */
  device?: EdgeDeviceContext;
};

export type EdgeObservationSource = "DEVICE" | "PROBE";

// ---------------------------------------------------------------------------
// 9.1.2 EdgeDeviceContext — device-level context
// ---------------------------------------------------------------------------

/**
 * Device context genuinely needed by the controller. Privacy-minimal by
 * construction — no arbitrary device telemetry.
 */
export type EdgeDeviceContext = {
  platform: "ios" | "android" | "web" | "unknown";
  appVersion: string;
  /** Primary network transport the device is using. */
  networkTransport: EdgeTransport;
  /** Whether the device is currently roaming. */
  roaming: boolean;
  /** Battery state (optional — informs BATTERY policy). */
  batteryState?: "charging" | "full" | "unplugged" | "low" | "unknown";
  /** Whether power-saver mode is active (informs BATTERY policy). */
  powerSaver?: boolean;
  /** Whether the current connection is metered (informs cost-aware policy). */
  metered: boolean;
};

// ---------------------------------------------------------------------------
// 9.1.3 EdgeConnectivityState — what the device observes
// ---------------------------------------------------------------------------

export type EdgeTransport = "WIFI" | "CELLULAR" | "ETHERNET" | "UNKNOWN";

export type EdgeConnectivityState = {
  transport: EdgeTransport;
  connected: boolean;
  /** Hashed SSID (privacy-preserving — never the raw SSID). */
  ssidHash?: string;
  /** Carrier name (cellular only). */
  carrier?: string;
  /** Signal quality 0–1 (device-reported, not authoritative). */
  signalQuality?: number;
  /** Observed downlink throughput (Mbps). */
  downlinkMbps?: number;
  /** Observed uplink throughput (Mbps). */
  uplinkMbps?: number;
  /** Observed latency (ms). */
  latencyMs?: number;
  /** Observed packet loss percentage (0–100). */
  packetLossPct?: number;
};

/**
 * Network context — coarser than connectivity state, used for policy hints.
 */
export type EdgeNetworkContext = {
  /** ISO country code of the current network (coarse). */
  country?: string;
  /** Whether the network is a captive portal. */
  captivePortal?: boolean;
  /** Network generation (cellular): "2g" | "3g" | "4g" | "5g" | "unknown". */
  generation?: string;
};

/**
 * Location context — coarse only, for coverage mapping. Never fine-grained.
 */
export type EdgeLocationContext = {
  /** ISO country code. */
  country?: string;
  /** Coarse region (admin level 1). */
  region?: string;
  /** Coarse city name. */
  city?: string;
};

// ---------------------------------------------------------------------------
// 9.1.4 EdgeObservationBatch + Ack — batch + sequence semantics
// ---------------------------------------------------------------------------

/**
 * A batch of observations uploaded by a device. Batching reduces HTTP overhead
 * and supports offline buffering (the outbox drains as a batch).
 */
export type EdgeObservationBatch = {
  deviceId: string;
  observations: EdgeObservation[];
};

/**
 * Server acknowledgment for a batch upload.
 *
 * The client uses `acceptedThroughSequence` to safely delete acknowledged
 * observations from its local outbox. Duplicates are counted (not errors).
 * Rejected observations (schema failure, auth failure) are returned with
 * reasons so the client can drop or fix them.
 */
export type EdgeObservationAck = {
  /** The highest sequence number fully accepted by the server. */
  acceptedThroughSequence: number;
  /** Number of duplicate observations detected and collapsed. */
  duplicateCount: number;
  /** Observations rejected (with reason). The client should drop these. */
  rejected: Array<{ observationId: string; reason: string }>;
  /** Server timestamp (ISO 8601) — lets the client sync its clock. */
  serverTime: string;
};

// ---------------------------------------------------------------------------
// 9.1.8 EdgePolicyContext — device context, NOT decisions
// ---------------------------------------------------------------------------

/**
 * Policy/context hints from the device. The device reports CONTEXT
 * (battery saver is on), not DECISIONS (switch to WiFi). The server-side
 * policy engine remains authoritative.
 *
 *   Device says:  batterySaver = true
 *   NOT:          SWITCH_TO_WIFI
 */
export type EdgePolicyContext = {
  /** User's connectivity preference hint. */
  connectivityPreference?: "CHEAPEST" | "RELIABLE" | "FASTEST" | "BALANCED";
  /** Whether the user is in a "work mode" (informs WORK policy). */
  workMode?: boolean;
  /** Battery saver is active (informs BATTERY policy). */
  batterySaver?: boolean;
  /** Avoid cellular when possible (cost/user preference). */
  avoidCellular?: boolean;
  /** Allow roaming connectivity. */
  allowRoaming?: boolean;
  /** Whether automatic switching is enabled by the user. */
  autoSwitchEnabled?: boolean;
};

// ---------------------------------------------------------------------------
// Edge device registration (lightweight — binds deviceId to authenticated user)
// ---------------------------------------------------------------------------

/**
 * A device registers once (on first observation) so the server can validate
 * that observations from a deviceId belong to the authenticated user.
 *
 * The deviceId is a client-generated stable identifier (stored in
 * AsyncStorage / SecureStore). The server does NOT trust deviceId alone —
 * it validates against the authenticated session.
 */
export type EdgeDeviceRegistration = {
  deviceId: string;
  platform: EdgeDeviceContext["platform"];
  appVersion: string;
  registeredAt: string;
};
