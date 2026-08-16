/**
 * RoamLink Connectivity Protocol v1 — Canonical Type Definitions
 *
 * These are the protocol vocabulary types. They are:
 *   - Provider-neutral
 *   - Commerce-neutral (no Product, Order, Payment references)
 *   - The canonical contract between web, API, database, and mobile
 *
 * The frozen connectivity kernel (entitlement, binding, lease, adapter)
 * sits BELOW this layer. Commerce/finance sits BESIDE it.
 *
 * Dependency rule: protocol → control-plane → connectivity kernel → adapters
 *                  commerce/finance → control-plane APIs (never the reverse)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Protocol Version
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = "v1" as const;

// ---------------------------------------------------------------------------
// ConnectivityIntent — what the user wants
// ---------------------------------------------------------------------------

export const LocationConstraintSchema = z.object({
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  radiusKm: z.number().optional(),
});

export const TimeWindowSchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

export const CapabilityRequirementsSchema = z.object({
  minDownloadMbps: z.number().optional(),
  minUploadMbps: z.number().optional(),
  maxLatencyMs: z.number().optional(),
  maxPacketLossPercent: z.number().optional(),
  minReliability: z.number().min(0).max(1).optional(),
  dataLimitBytes: z.number().optional(),
  validityDays: z.number().optional(),
  allowedCountries: z.array(z.string()).optional(),
});

export const BudgetConstraintSchema = z.object({
  currency: z.string().default("USD"),
  maxMinor: z.number().optional(),
});

export const ConnectivityIntentSchema = z.object({
  id: z.string().optional(),
  subjectId: z.string(),
  location: LocationConstraintSchema.optional(),
  timeWindow: TimeWindowSchema.optional(),
  capabilityRequirements: CapabilityRequirementsSchema.optional(),
  budget: BudgetConstraintSchema.optional(),
  priorities: z.array(z.enum(["RELIABILITY", "PRICE", "SPEED", "LATENCY", "COVERAGE"])).optional(),
  mode: z.enum(["AUTOMATIC", "MANUAL"]).default("MANUAL"),
  rawText: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0),
  createdAt: z.string().datetime().optional(),
});

export type ConnectivityIntent = z.infer<typeof ConnectivityIntentSchema>;

// ---------------------------------------------------------------------------
// ConnectivityCapability — technical description of supply
// ---------------------------------------------------------------------------

export const ConnectivityCapabilitySchema = z.object({
  id: z.string().optional(),
  type: z.enum(["INTERNET", "ROAMING", "LOCAL_NETWORK", "VPN_ACCESS", "CACHE_ACCESS", "MESH_RELAY"]),
  providerType: z.string(),
  bandwidth: z.object({
    downloadMbps: z.number().optional(),
    uploadMbps: z.number().optional(),
  }).optional(),
  latency: z.object({
    typicalMs: z.number().optional(),
    maxMs: z.number().optional(),
  }).optional(),
  reliability: z.number().min(0).max(1).optional(),
  geographicCoverage: z.object({
    countries: z.array(z.string()).optional(),
    regions: z.array(z.string()).optional(),
    cities: z.array(z.string()).optional(),
  }).optional(),
  mobility: z.boolean().default(false),
  metering: z.enum(["UNMETERED", "METERED", "PREPAID"]).default("PREPAID"),
  providerInstanceId: z.string().optional(),
});

export type ConnectivityCapability = z.infer<typeof ConnectivityCapabilitySchema>;

// ---------------------------------------------------------------------------
// ConnectivityResource — actual provider-side resource
// ---------------------------------------------------------------------------

export const ConnectivityResourceSchema = z.object({
  id: z.string().optional(),
  providerInstanceId: z.string(),
  capabilityType: z.string(),
  state: z.enum(["AVAILABLE", "IN_USE", "DEGRADED", "OFFLINE", "UNKNOWN"]).default("UNKNOWN"),
  location: LocationConstraintSchema.optional(),
  identifiers: z.record(z.string()).optional(),
  capacity: z.object({
    maxConcurrentUsers: z.number().optional(),
    totalBandwidthMbps: z.number().optional(),
    availableBandwidthMbps: z.number().optional(),
  }).optional(),
});

export type ConnectivityResource = z.infer<typeof ConnectivityResourceSchema>;

// ---------------------------------------------------------------------------
// ConnectivityOffer — commercial realization of a resource/capability
// ---------------------------------------------------------------------------

export const ConnectivityOfferSchema = z.object({
  id: z.string().optional(),
  capability: ConnectivityCapabilitySchema,
  resourceId: z.string().optional(),
  commercialTerms: z.object({
    wholesalePriceMinor: z.number(),
    customerPriceMinor: z.number(),
    currency: z.string().default("USD"),
    billingCycle: z.enum(["one_time", "monthly", "prepaid", "usage_based"]).default("one_time"),
  }),
  availabilityWindow: z.object({
    validFrom: z.string().datetime().optional(),
    validUntil: z.string().datetime().optional(),
  }).optional(),
  trustMetadata: z.object({
    reliabilityScore: z.number().min(0).max(1).default(0.5),
    successCount: z.number().default(0),
    failureCount: z.number().default(0),
    avgRating: z.number().min(0).max(5).optional(),
    ratingCount: z.number().default(0),
  }).optional(),
});

export type ConnectivityOffer = z.infer<typeof ConnectivityOfferSchema>;

// ---------------------------------------------------------------------------
// ConnectivitySession — current active connectivity
// ---------------------------------------------------------------------------

export const ConnectivitySessionStateSchema = z.enum([
  "PLANNED",
  "DISCOVERING",
  "RESERVED",
  "ACTIVE",
  "DEGRADED",
  "SWITCHING",
  "ENDED",
  "FAILED",
]);

export const ConnectivitySessionSchema = z.object({
  id: z.string().optional(),
  subjectId: z.string(),
  intentId: z.string().optional(),
  entitlementId: z.string().optional(),
  activeResourceId: z.string().optional(),
  state: ConnectivitySessionStateSchema.default("PLANNED"),
  startedAt: z.string().datetime().optional(),
  lastObservedAt: z.string().datetime().optional(),
  policyId: z.string().optional(),
});

export type ConnectivitySession = z.infer<typeof ConnectivitySessionSchema>;
export type ConnectivitySessionState = z.infer<typeof ConnectivitySessionStateSchema>;

// Legal session state transitions
export const SESSION_TRANSITIONS: Record<ConnectivitySessionState, ConnectivitySessionState[]> = {
  PLANNED: ["DISCOVERING", "ENDED", "FAILED"],
  DISCOVERING: ["RESERVED", "ACTIVE", "FAILED", "ENDED"],
  RESERVED: ["ACTIVE", "FAILED", "ENDED"],
  ACTIVE: ["DEGRADED", "SWITCHING", "ENDED", "FAILED"],
  DEGRADED: ["ACTIVE", "SWITCHING", "ENDED", "FAILED"],
  SWITCHING: ["ACTIVE", "DEGRADED", "FAILED", "ENDED"],
  ENDED: [],
  FAILED: ["PLANNED", "ENDED"],
};

// ---------------------------------------------------------------------------
// ConnectivityMeasurement — quality/usage observation
// ---------------------------------------------------------------------------

export const MeasurementTypeSchema = z.enum(["USAGE", "QUALITY", "AVAILABILITY"]);

/**
 * Phase 8.6: Measurement provenance. The source field is the critical
 * provenance marker — provider-reported metrics and client-observed metrics
 * must never be mixed without preserving which is which.
 *
 *   ADAPTER  — the provider adapter reported this (getUsage/reconcile)
 *   DEVICE   — the end-user device observed this (client telemetry)
 *   PROBE    — an independent probe/synthetic check observed this
 *   PROVIDER — the supplier's own API reported this (raw, pre-adapter)
 *   DERIVED  — computed from other measurements (aggregates, sma)
 */
export const MeasurementSourceSchema = z.enum([
  "ADAPTER",
  "DEVICE",
  "PROBE",
  "PROVIDER",
  "DERIVED",
]);
export type MeasurementSource = z.infer<typeof MeasurementSourceSchema>;

/**
 * Phase 8.6: Measurement freshness, computed from capturedAt at ingestion.
 *   FRESH   age < 30s   — may trigger automatic decisions
 *   STALE   30s–120s    — informs health, must NOT be the sole switch trigger
 *   EXPIRED > 120s      — excluded from health derivation entirely
 *   UNKNOWN              — capturedAt missing / not computed
 */
export const MeasurementFreshnessSchema = z.enum(["FRESH", "STALE", "EXPIRED", "UNKNOWN"]);
export type MeasurementFreshness = z.infer<typeof MeasurementFreshnessSchema>;

export const ConnectivityMeasurementSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  resourceId: z.string().optional(),
  providerInstanceId: z.string().optional(),
  type: MeasurementTypeSchema,
  metrics: z.object({
    throughputDownMbps: z.number().optional(),
    throughputUpMbps: z.number().optional(),
    latencyMs: z.number().optional(),
    jitterMs: z.number().optional(),
    packetLossPercent: z.number().optional(),
    signalQuality: z.number().min(0).max(1).optional(),
    availability: z.number().min(0).max(1).optional(),
    dataUsedBytes: z.number().optional(),
    dataRemainingBytes: z.number().optional(),
    isActive: z.boolean().optional(),
  }),
  freshness: MeasurementFreshnessSchema.default("UNKNOWN"),
  source: MeasurementSourceSchema.default("PROVIDER"),
  confidence: z.number().min(0).max(1).default(0.5),
  capturedAt: z.string().datetime(),
});

export type ConnectivityMeasurement = z.infer<typeof ConnectivityMeasurementSchema>;

// ---------------------------------------------------------------------------
// Phase 8.6 — Resource Health (persisted, derived from the measurement stream)
// ---------------------------------------------------------------------------

export const HealthStatusSchema = z.enum(["HEALTHY", "DEGRADED", "UNKNOWN"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ResourceHealthSchema = z.object({
  id: z.string().optional(),
  resourceId: z.string(),
  sessionId: z.string().optional(),
  status: HealthStatusSchema.default("UNKNOWN"),
  quality: z.number().min(0).max(1).default(0),
  sampleCount: z.number().int().default(0),
  degradedCount: z.number().int().default(0),
  freshness: MeasurementFreshnessSchema.default("UNKNOWN"),
  derivedFromSources: z.string().optional(),
  latestMeasurementId: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type ResourceHealth = z.infer<typeof ResourceHealthSchema>;

// ---------------------------------------------------------------------------
// Phase 8.6 — Re-evaluation Events (event-driven decision triggers)
// ---------------------------------------------------------------------------

export const ReevaluationEventTypeSchema = z.enum([
  "MEASUREMENT_RECEIVED",
  "RESOURCE_DEGRADED",
  "RESOURCE_RECOVERED",
  "QUOTA_THRESHOLD_REACHED",
  "PROVIDER_UNAVAILABLE",
  "LOCATION_CHANGED",
  "POLICY_CHANGED",
]);
export type ReevaluationEventType = z.infer<typeof ReevaluationEventTypeSchema>;

// ---------------------------------------------------------------------------
// ConnectivityPolicy — deterministic rules for autonomous decisions
// ---------------------------------------------------------------------------

export const ConnectivityPolicySchema = z.object({
  id: z.string().optional(),
  subjectId: z.string(),
  mode: z.enum(["automatic", "manual"]).default("manual"),
  maxAutoSpendMinor: z.number().default(0),
  preferredTransports: z.array(z.string()).default([]),
  minReliability: z.number().min(0).max(1).default(0.5),
  switchHysteresis: z.number().min(0).max(1).default(0.15),
  requireUserApprovalForPurchase: z.boolean().default(true),
  neverInterruptActiveCall: z.boolean().default(true),
});

export type ConnectivityPolicy = z.infer<typeof ConnectivityPolicySchema>;

// ---------------------------------------------------------------------------
// ConnectivityDecision — what the system should do
// ---------------------------------------------------------------------------

export const DecisionActionSchema = z.enum([
  "KEEP",
  "SWITCH",
  "ACTIVATE",
  "RESERVE",
  "RENEW",
  "RELEASE",
  "WAIT",
  "ASK_USER",
]);

export const ConnectivityDecisionSchema = z.object({
  id: z.string().optional(),
  intentId: z.string(),
  sessionId: z.string().optional(),
  action: DecisionActionSchema,
  targetResourceId: z.string().optional(),
  targetOfferId: z.string().optional(),
  score: z.number(),
  constraintsSatisfied: z.array(z.string()),
  constraintsViolated: z.array(z.string()),
  reasons: z.array(z.string()),
  policyVersion: z.string().optional(),
  createdAt: z.string().datetime().optional(),
});

export type ConnectivityDecision = z.infer<typeof ConnectivityDecisionSchema>;

// ---------------------------------------------------------------------------
// ConnectivityAction — protocol command with lifecycle
// ---------------------------------------------------------------------------

export const ActionTypeSchema = z.enum([
  "DISCOVER",
  "RESERVE",
  "ACTIVATE",
  "SWITCH",
  "SUSPEND",
  "RESUME",
  "RENEW",
  "RELEASE",
  "TRANSFER",
]);

export const ActionStateSchema = z.enum([
  "PLANNED",
  "AUTHORIZED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
  "RECOVERY_CLAIMED",
]);

export const ConnectivityActionSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string(),
  decisionId: z.string().optional(),
  type: ActionTypeSchema,
  targetResourceId: z.string().optional(),
  state: ActionStateSchema.default("PLANNED"),
  reason: z.string().optional(),
  policyVersion: z.string().optional(),
  idempotencyKey: z.string(),
  createdAt: z.string().datetime().optional(),
  executedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export type ConnectivityAction = z.infer<typeof ConnectivityActionSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type ActionState = z.infer<typeof ActionStateSchema>;

// Legal action state transitions
export const ACTION_TRANSITIONS: Record<ActionState, ActionState[]> = {
  PLANNED: ["AUTHORIZED", "FAILED", "UNKNOWN"],
  AUTHORIZED: ["EXECUTING", "FAILED", "PLANNED"],
  EXECUTING: ["SUCCEEDED", "FAILED", "UNKNOWN", "RECONCILIATION_REQUIRED", "RECOVERY_CLAIMED"],
  SUCCEEDED: [],
  FAILED: ["PLANNED", "RECONCILIATION_REQUIRED"],
  UNKNOWN: ["RECONCILIATION_REQUIRED", "PLANNED"],
  RECONCILIATION_REQUIRED: ["SUCCEEDED", "FAILED", "PLANNED"],
  RECOVERY_CLAIMED: ["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"],
};
