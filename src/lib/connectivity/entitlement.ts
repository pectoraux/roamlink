/**
 * Phase 2C.1 — Connectivity Entitlement Kernel
 *
 * This module implements the connectivity entitlement layer that sits between
 * the SaaS billing kernel (FROZEN) and provider-specific adapters (MikroTik,
 * WiFi ISP, eSIM).
 *
 * Three layers of truth:
 *   Commercial Truth: TenantSubscription (billing kernel — FROZEN)
 *   Entitlement Truth: ConnectivityEntitlement (this layer)
 *   Infrastructure Truth: ProviderResourceBinding (this layer)
 *
 * The entitlement kernel does NOT know about MikroTik, RADIUS, eSIM suppliers,
 * or ISP APIs. It only expresses what connectivity capability a customer owns.
 *
 * Carryover principle from SaaS hardening:
 *   "Every external side effect needs a durable state machine and reconciliation path."
 *
 * Entitlement Lifecycle: PENDING → ACTIVE → (SUSPENDED | EXPIRED | REVOKED)
 * Binding Lifecycle:     UNBOUND → PROVISIONING → BOUND → (DEGRADED | FAILED | RELEASED)
 *
 * The separation matters:
 *   An ACTIVE entitlement can coexist with a FAILED binding (router offline).
 *   Billing must not interpret infrastructure unhealthiness as a payment problem.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";

// ---------------------------------------------------------------------------
// Capability Types
// ---------------------------------------------------------------------------

export const CAPABILITY_TYPES = {
  INTERNET: "INTERNET",
  LOCAL_NETWORK: "LOCAL_NETWORK",
  CACHE_ACCESS: "CACHE_ACCESS",
  MESH_RELAY: "MESH_RELAY",
  VPN_ACCESS: "VPN_ACCESS",
  ROAMING: "ROAMING",
} as const;

export type CapabilityType = typeof CAPABILITY_TYPES[keyof typeof CAPABILITY_TYPES];

// ---------------------------------------------------------------------------
// Entitlement State Machine
// ---------------------------------------------------------------------------

export const ENTITLEMENT_STATES = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
} as const;

export type EntitlementState = typeof ENTITLEMENT_STATES[keyof typeof ENTITLEMENT_STATES];

/**
 * Legal entitlement state transitions.
 * Any transition not listed here is rejected.
 */
const ENTITLEMENT_TRANSITIONS: Record<EntitlementState, EntitlementState[]> = {
  PENDING: [ENTITLEMENT_STATES.ACTIVE, ENTITLEMENT_STATES.REVOKED],
  ACTIVE: [ENTITLEMENT_STATES.SUSPENDED, ENTITLEMENT_STATES.EXPIRED, ENTITLEMENT_STATES.REVOKED],
  SUSPENDED: [ENTITLEMENT_STATES.ACTIVE, ENTITLEMENT_STATES.REVOKED],
  EXPIRED: [], // terminal
  REVOKED: [], // terminal
};

// ---------------------------------------------------------------------------
// Binding State Machine
// ---------------------------------------------------------------------------

export const BINDING_STATES = {
  UNBOUND: "UNBOUND",
  PROVISIONING: "PROVISIONING",
  BOUND: "BOUND",
  DEGRADED: "DEGRADED",
  FAILED: "FAILED",
  RELEASED: "RELEASED",
} as const;

export type BindingState = typeof BINDING_STATES[keyof typeof BINDING_STATES];

/**
 * Legal binding state transitions.
 * Any transition not listed here is rejected.
 */
const BINDING_TRANSITIONS: Record<BindingState, BindingState[]> = {
  UNBOUND: [BINDING_STATES.PROVISIONING, BINDING_STATES.FAILED],
  PROVISIONING: [BINDING_STATES.BOUND, BINDING_STATES.FAILED],
  BOUND: [BINDING_STATES.DEGRADED, BINDING_STATES.FAILED, BINDING_STATES.RELEASED],
  DEGRADED: [BINDING_STATES.BOUND, BINDING_STATES.FAILED, BINDING_STATES.RELEASED],
  FAILED: [BINDING_STATES.PROVISIONING, BINDING_STATES.RELEASED], // can retry provisioning
  RELEASED: [], // terminal
};

// ---------------------------------------------------------------------------
// Capability Management
// ---------------------------------------------------------------------------

/**
 * Seed the standard connectivity capabilities. Idempotent — safe to call
 * multiple times. Called during system initialization.
 */
export async function seedConnectivityCapabilities(): Promise<void> {
  const capabilities = [
    {
      type: CAPABILITY_TYPES.INTERNET,
      displayName: "Internet Access",
      description: "General internet connectivity with configurable bandwidth and quota",
      attributes: JSON.stringify({
        downloadMbps: "number",
        uploadMbps: "number",
        monthlyQuotaBytes: "number",
      }),
    },
    {
      type: CAPABILITY_TYPES.LOCAL_NETWORK,
      displayName: "Local Network Access",
      description: "Access to local network resources (LAN, intranet)",
      attributes: JSON.stringify({
        networkId: "string",
      }),
    },
    {
      type: CAPABILITY_TYPES.CACHE_ACCESS,
      displayName: "Cached Content Access",
      description: "Access to cached/CDN content without internet transit",
      attributes: JSON.stringify({
        cacheNodeId: "string",
      }),
    },
    {
      type: CAPABILITY_TYPES.MESH_RELAY,
      displayName: "Mesh Network Relay",
      description: "Participation in a community mesh network as relay node",
      attributes: JSON.stringify({
        meshId: "string",
        relayPriority: "number",
      }),
    },
    {
      type: CAPABILITY_TYPES.VPN_ACCESS,
      displayName: "VPN Access",
      description: "VPN tunnel access for secure remote connectivity",
      attributes: JSON.stringify({
        serverId: "string",
        protocol: "string",
      }),
    },
    {
      type: CAPABILITY_TYPES.ROAMING,
      displayName: "Roaming Access",
      description: "Cross-provider roaming capability for travel connectivity",
      attributes: JSON.stringify({
        allowedCountries: "string[]",
        dataLimitBytes: "number",
      }),
    },
  ];

  for (const cap of capabilities) {
    await db.connectivityCapability.upsert({
      where: { type: cap.type },
      create: cap,
      update: { displayName: cap.displayName, description: cap.description, attributes: cap.attributes },
    });
  }

  logger.info("connectivity.capabilities_seeded", { count: capabilities.length });
}

// ---------------------------------------------------------------------------
// Entitlement Management
// ---------------------------------------------------------------------------

/**
 * Create a connectivity entitlement for a tenant.
 *
 * The entitlement represents the customer's RIGHT to consume connectivity.
 * It starts in PENDING state and must be explicitly activated.
 *
 * The entitlement is linked to a subscription (commercial truth) but does
 * not depend on the subscription's payment state — that's the billing kernel's
 * responsibility. This layer only tracks the capability grant.
 */
export async function createEntitlement(input: {
  tenantId: string;
  subscriptionId: string;
  capabilityType: CapabilityType;
  capabilitySet: Record<string, unknown>;
  policy?: Record<string, unknown>;
  validFrom: Date;
  validUntil?: Date;
  userId?: string;
}): Promise<{ id: string; status: string }> {
  // Look up the capability by type
  const capability = await db.connectivityCapability.findUnique({
    where: { type: input.capabilityType },
  });
  if (!capability) {
    throw new AppError("not_found", "Capability not found", 404, `Capability type "${input.capabilityType}" does not exist. Run seedConnectivityCapabilities() first.`);
  }

  const entitlement = await db.connectivityEntitlement.create({
    data: {
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      capabilityId: capability.id,
      status: ENTITLEMENT_STATES.PENDING,
      capabilitySet: JSON.stringify(input.capabilitySet),
      policy: input.policy ? JSON.stringify(input.policy) : null,
      validFrom: input.validFrom,
      validUntil: input.validUntil ?? null,
    },
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "connectivity.entitlement_created",
    entity: "connectivity_entitlement",
    entityId: entitlement.id,
    detail: {
      capabilityType: input.capabilityType,
      subscriptionId: input.subscriptionId,
      capabilitySet: input.capabilitySet,
    },
  });

  logger.info("connectivity.entitlement_created", {
    entitlementId: entitlement.id, tenantId: input.tenantId,
    capabilityType: input.capabilityType, subscriptionId: input.subscriptionId,
  });

  return { id: entitlement.id, status: entitlement.status };
}

/**
 * Transition an entitlement to a new state.
 * Uses a guarded updateMany — only the legal predecessor state can transition.
 * Returns { transitioned: false } if the guard doesn't match (idempotent).
 */
export async function transitionEntitlement(input: {
  entitlementId: string;
  toState: EntitlementState;
  reason?: string;
  userId?: string;
}): Promise<{ transitioned: boolean; status: string }> {
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: input.entitlementId },
    select: { id: true, status: true, tenantId: true },
  });
  if (!entitlement) {
    throw new AppError("not_found", "Entitlement not found", 404, "Connectivity entitlement not found.");
  }

  const currentState = entitlement.status as EntitlementState;
  const legalTransitions = ENTITLEMENT_TRANSITIONS[currentState] || [];

  // Check if this is a valid transition
  if (!legalTransitions.includes(input.toState)) {
    if (currentState === input.toState) {
      // Idempotent — already in the target state
      return { transitioned: false, status: currentState };
    }
    throw new AppError(
      "conflict",
      "Invalid entitlement transition",
      409,
      `Cannot transition entitlement from ${currentState} to ${input.toState}. Legal transitions from ${currentState}: ${legalTransitions.join(", ") || "none (terminal state)"}.`,
    );
  }

  // Guarded transition — only the expected predecessor state can transition
  const result = await db.connectivityEntitlement.updateMany({
    where: { id: input.entitlementId, status: currentState },
    data: { status: input.toState, failureReason: input.reason ?? null },
  });

  if (result.count === 0) {
    // Concurrent transition — another worker moved it first
    logger.info("connectivity.entitlement_transition_concurrent", {
      entitlementId: input.entitlementId, fromState: currentState, toState: input.toState,
    });
    return { transitioned: false, status: currentState };
  }

  await audit({
    tenantId: entitlement.tenantId,
    userId: input.userId,
    action: "connectivity.entitlement_transitioned",
    entity: "connectivity_entitlement",
    entityId: input.entitlementId,
    detail: { from: currentState, to: input.toState, reason: input.reason },
  });

  logger.info("connectivity.entitlement_transitioned", {
    entitlementId: input.entitlementId, from: currentState, to: input.toState,
  });

  return { transitioned: true, status: input.toState };
}

/**
 * List all entitlements for a tenant.
 */
export async function listEntitlements(tenantId: string) {
  return db.connectivityEntitlement.findMany({
    where: { tenantId },
    include: {
      capability: true,
      resourceBindings: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get a single entitlement by ID.
 */
export async function getEntitlement(entitlementId: string, tenantId: string) {
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: entitlementId },
    include: {
      capability: true,
      resourceBindings: true,
    },
  });
  if (!entitlement || entitlement.tenantId !== tenantId) {
    throw new AppError("not_found", "Entitlement not found", 404, "Connectivity entitlement not found.");
  }
  return entitlement;
}

// ---------------------------------------------------------------------------
// Provider Resource Binding Management
// ---------------------------------------------------------------------------

/**
 * Create a provider resource binding for an entitlement.
 *
 * The binding represents the actual external resource that delivers the capability.
 * It starts in UNBOUND state and must transition through PROVISIONING → BOUND.
 *
 * The providerType is provider-neutral ("mock", "mikrotik", "wifi-isp", "esim").
 * The providerMetadata is opaque JSON — the entitlement kernel does NOT interpret it.
 */
export async function createResourceBinding(input: {
  entitlementId: string;
  providerType: string;
  providerMetadata?: Record<string, unknown>;
  userId?: string;
}): Promise<{ id: string; status: string }> {
  const binding = await db.providerResourceBinding.create({
    data: {
      entitlementId: input.entitlementId,
      providerType: input.providerType,
      providerMetadata: input.providerMetadata ? JSON.stringify(input.providerMetadata) : null,
      status: BINDING_STATES.UNBOUND,
    },
  });

  await audit({
    tenantId: undefined, // bindings don't have direct tenantId — it's on the entitlement
    userId: input.userId,
    action: "connectivity.binding_created",
    entity: "provider_resource_binding",
    entityId: binding.id,
    detail: {
      entitlementId: input.entitlementId,
      providerType: input.providerType,
    },
  });

  logger.info("connectivity.binding_created", {
    bindingId: binding.id, entitlementId: input.entitlementId,
    providerType: input.providerType,
  });

  return { id: binding.id, status: binding.status };
}

/**
 * Transition a resource binding to a new state.
 * Uses a guarded updateMany — only the legal predecessor state can transition.
 */
export async function transitionBinding(input: {
  bindingId: string;
  toState: BindingState;
  providerResourceId?: string;
  providerMetadata?: Record<string, unknown>;
  provisioningState?: string;
  reason?: string;
  userId?: string;
}): Promise<{ transitioned: boolean; status: string }> {
  const binding = await db.providerResourceBinding.findUnique({
    where: { id: input.bindingId },
    select: { id: true, status: true, entitlementId: true },
  });
  if (!binding) {
    throw new AppError("not_found", "Binding not found", 404, "Provider resource binding not found.");
  }

  const currentState = binding.status as BindingState;
  const legalTransitions = BINDING_TRANSITIONS[currentState] || [];

  if (!legalTransitions.includes(input.toState)) {
    if (currentState === input.toState) {
      return { transitioned: false, status: currentState };
    }
    throw new AppError(
      "conflict",
      "Invalid binding transition",
      409,
      `Cannot transition binding from ${currentState} to ${input.toState}. Legal transitions from ${currentState}: ${legalTransitions.join(", ") || "none (terminal state)"}.`,
    );
  }

  const updateData: Record<string, unknown> = {
    status: input.toState,
    failureReason: input.reason ?? null,
  };
  if (input.providerResourceId !== undefined) {
    updateData.providerResourceId = input.providerResourceId;
  }
  if (input.providerMetadata !== undefined) {
    updateData.providerMetadata = JSON.stringify(input.providerMetadata);
  }
  if (input.provisioningState !== undefined) {
    updateData.provisioningState = input.provisioningState;
  }

  const result = await db.providerResourceBinding.updateMany({
    where: { id: input.bindingId, status: currentState },
    data: updateData,
  });

  if (result.count === 0) {
    logger.info("connectivity.binding_transition_concurrent", {
      bindingId: input.bindingId, fromState: currentState, toState: input.toState,
    });
    return { transitioned: false, status: currentState };
  }

  logger.info("connectivity.binding_transitioned", {
    bindingId: input.bindingId, from: currentState, to: input.toState,
  });

  return { transitioned: true, status: input.toState };
}

/**
 * List all resource bindings for an entitlement.
 */
export async function listResourceBindings(entitlementId: string) {
  return db.providerResourceBinding.findMany({
    where: { entitlementId },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Reconciliation Framework
// ---------------------------------------------------------------------------

/**
 * Reconcile connectivity entitlements and their resource bindings.
 *
 * This is the Phase 2C equivalent of the SaaS reconciliation worker.
 * It checks for drift between desired and observed state:
 *
 *   - Entitlements that should be ACTIVE but have no BOUND binding
 *   - Bindings that are FAILED but the entitlement is still ACTIVE
 *   - Entitlements past their validUntil that haven't been EXPIRED
 *   - Bindings in PROVISIONING for too long (stuck)
 *
 * This function is idempotent — running it multiple times produces the same
 * state. It does NOT create or destroy resources — only transitions state
 * and marks reconciliation flags.
 */
export async function reconcileConnectivityEntitlements(): Promise<{
  entitlementsExpired: number;
  bindingsStuck: number;
  driftDetected: number;
  reconciled: number;
}> {
  const result = { entitlementsExpired: 0, bindingsStuck: 0, driftDetected: 0, reconciled: 0 };
  const now = new Date();

  // 1. Expire entitlements past their validUntil
  const expired = await db.connectivityEntitlement.updateMany({
    where: {
      status: { in: [ENTITLEMENT_STATES.PENDING, ENTITLEMENT_STATES.ACTIVE, ENTITLEMENT_STATES.SUSPENDED] },
      validUntil: { lt: now },
    },
    data: {
      status: ENTITLEMENT_STATES.EXPIRED,
      reconciliationState: "RECONCILED",
    },
  });
  result.entitlementsExpired = expired.count;

  // 2. Detect stuck PROVISIONING bindings (older than 5 minutes)
  const stuckCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const stuckBindings = await db.providerResourceBinding.findMany({
    where: {
      status: BINDING_STATES.PROVISIONING,
      updatedAt: { lt: stuckCutoff },
    },
    select: { id: true, entitlementId: true },
  });

  for (const binding of stuckBindings) {
    // Mark as RECONCILIATION_REQUIRED — the provider adapter should retry
    const stuckResult = await db.providerResourceBinding.updateMany({
      where: { id: binding.id, status: BINDING_STATES.PROVISIONING },
      data: {
        reconciliationState: "RECONCILIATION_REQUIRED",
        failureReason: "Provisioning stuck for > 5 minutes — provider adapter should retry",
      },
    });
    if (stuckResult.count > 0) {
      result.bindingsStuck++;
      logger.warn("connectivity.binding_stuck", {
        bindingId: binding.id, entitlementId: binding.entitlementId,
      });
    }
  }

  // 3. Detect drift: ACTIVE entitlements with no BOUND binding
  const activeEntitlements = await db.connectivityEntitlement.findMany({
    where: { status: ENTITLEMENT_STATES.ACTIVE },
    select: { id: true, tenantId: true },
  });

  for (const ent of activeEntitlements) {
    const bindings = await db.providerResourceBinding.findMany({
      where: { entitlementId: ent.id },
      select: { status: true },
    });

    const hasBound = bindings.some((b) => b.status === BINDING_STATES.BOUND);
    if (!hasBound && bindings.length > 0) {
      // Entitlement is ACTIVE but no binding is BOUND — drift
      const driftResult = await db.connectivityEntitlement.updateMany({
        where: { id: ent.id, status: ENTITLEMENT_STATES.ACTIVE },
        data: { reconciliationState: "RECONCILIATION_REQUIRED" },
      });
      if (driftResult.count > 0) {
        result.driftDetected++;
        logger.warn("connectivity.entitlement_drift", {
          entitlementId: ent.id, tenantId: ent.tenantId,
          message: "ACTIVE entitlement has no BOUND binding — reconciliation required",
        });
      }
    } else if (hasBound) {
      // Entitlement is ACTIVE and has a BOUND binding — mark reconciled
      const reconResult = await db.connectivityEntitlement.updateMany({
        where: { id: ent.id, status: ENTITLEMENT_STATES.ACTIVE, reconciliationState: "RECONCILIATION_REQUIRED" },
        data: { reconciliationState: "RECONCILED" },
      });
      if (reconResult.count > 0) {
        result.reconciled++;
      }
    }
  }

  logger.info("connectivity.reconciliation_completed", result);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2C.2.2: Reconciliation Boundary — Adapter Reports, Kernel Decides
// (Atomic, Stale-Observation-Safe, Kernel-Validated Transitions)
// ---------------------------------------------------------------------------

/**
 * Phase 2C.2.2: Kernel-owned legal transition matrix for reconciliation-driven
 * binding state transitions.
 *
 * The adapter may RETURN a recommendedBindingState, but the kernel VALIDATES
 * it against this matrix. If the transition is not legal, the kernel refuses
 * it and marks the binding for manual intervention.
 *
 * This prevents an adapter from putting a binding into an illegal state.
 */
const RECONCILIATION_LEGAL_TRANSITIONS: Record<string, BindingState[]> = {
  // From BOUND: can degrade, fail, or release (not unbind or re-provision)
  BOUND: [BINDING_STATES.DEGRADED, BINDING_STATES.FAILED, BINDING_STATES.RELEASED],
  // From DEGRADED: can recover to BOUND, fail, or release
  DEGRADED: [BINDING_STATES.BOUND, BINDING_STATES.FAILED, BINDING_STATES.RELEASED],
  // From PROVISIONING: can succeed to BOUND or fail
  PROVISIONING: [BINDING_STATES.BOUND, BINDING_STATES.FAILED],
  // From UNBOUND: can start provisioning or fail
  UNBOUND: [BINDING_STATES.PROVISIONING, BINDING_STATES.FAILED],
  // From FAILED: can retry provisioning or release (NOT directly to BOUND)
  FAILED: [BINDING_STATES.PROVISIONING, BINDING_STATES.RELEASED],
  // From RELEASED: terminal — no transitions
  RELEASED: [],
};

/**
 * Phase 2C.2.2: Check if a reconciliation-driven transition is legal.
 */
function isLegalReconciliationTransition(fromState: string, toState: BindingState): boolean {
  const legal = RECONCILIATION_LEGAL_TRANSITIONS[fromState] || [];
  return legal.includes(toState);
}

/**
 * Phase 2C.2.2: Map a ReconciliationResult to a target binding state + reconciliation metadata.
 *
 * The kernel owns this mapping — the adapter's recommendation is a SIGNAL,
 * not authority. The kernel validates the recommended transition against
 * the legal transition matrix.
 *
 * Returns:
 *   - targetBindingState: the state to transition to (if any)
 *   - reconciliationState: the durable reconciliation metadata
 *   - failureReason: optional failure reason
 */
function mapReconciliationResult(
  currentBindingStatus: string,
  result: { status: string; recommendedBindingState?: string; details?: string },
): {
  targetBindingState: BindingState | null;
  reconciliationState: string;
  failureReason: string | null;
} {
  switch (result.status) {
    case "in_sync":
      return {
        targetBindingState: null, // no transition
        reconciliationState: "RECONCILED",
        failureReason: null,
      };

    case "drift_detected": {
      // The adapter recommends a state — the kernel validates it
      const recommended = result.recommendedBindingState as BindingState | undefined;
      if (recommended && isLegalReconciliationTransition(currentBindingStatus, recommended)) {
        return {
          targetBindingState: recommended,
          reconciliationState: "RECONCILED",
          failureReason: result.details ?? "Provider drift detected",
        };
      }
      // Recommendation is missing or illegal — fail closed
      return {
        targetBindingState: null,
        reconciliationState: "MANUAL_INTERVENTION_REQUIRED",
        failureReason: `Adapter recommended "${recommended}" from "${currentBindingStatus}" — illegal or missing. Manual intervention required.`,
      };
    }

    case "resource_missing":
      // Resource is gone — transition to FAILED if legal
      if (isLegalReconciliationTransition(currentBindingStatus, BINDING_STATES.FAILED)) {
        return {
          targetBindingState: BINDING_STATES.FAILED,
          reconciliationState: "RECONCILED",
          failureReason: "Provider resource missing",
        };
      }
      // Can't transition to FAILED from current state — manual intervention
      return {
        targetBindingState: null,
        reconciliationState: "MANUAL_INTERVENTION_REQUIRED",
        failureReason: `resource_missing from "${currentBindingStatus}" — cannot transition to FAILED`,
      };

    case "failed_retryable":
      // Keep current state — retry later
      return {
        targetBindingState: null,
        reconciliationState: "RECONCILIATION_REQUIRED",
        failureReason: result.details ?? "Retryable reconciliation failure",
      };

    case "failed_permanent":
      // Phase 2C.2.2: Use MANUAL_INTERVENTION_REQUIRED (NOT RECONCILIATION_REQUIRED)
      // to prevent the automatic retry loop from picking this up.
      // Transition to FAILED if legal, but mark as manual intervention.
      if (isLegalReconciliationTransition(currentBindingStatus, BINDING_STATES.FAILED)) {
        return {
          targetBindingState: BINDING_STATES.FAILED,
          reconciliationState: "MANUAL_INTERVENTION_REQUIRED",
          failureReason: result.details ?? "Permanent reconciliation failure",
        };
      }
      return {
        targetBindingState: null,
        reconciliationState: "MANUAL_INTERVENTION_REQUIRED",
        failureReason: `Permanent failure from "${currentBindingStatus}" — cannot transition to FAILED`,
      };

    default:
      return {
        targetBindingState: null,
        reconciliationState: "MANUAL_INTERVENTION_REQUIRED",
        failureReason: `Unknown reconciliation status: ${result.status}`,
      };
  }
}

/**
 * Phase 2C.2.2: Reconcile a single binding with its provider.
 *
 * ATOMIC RECONCILIATION:
 *   The entire operation (observe → validate → transition → commit) is
 *   performed inside ONE PostgreSQL transaction with FOR UPDATE on the
 *   ProviderResourceBinding row. This prevents:
 *     - Partial reconciliation (transition succeeds but metadata write fails)
 *     - Concurrent reconciliation overwriting each other
 *     - Stale observations overwriting newer state
 *
 * STALE OBSERVATION PREVENTION:
 *   The binding's status is captured BEFORE the adapter call. After the
 *   adapter returns, the transaction locks the row and verifies the status
 *   hasn't changed. If it has, the reconciliation is a no-op (the observation
 *   is stale).
 *
 * RECONCILIATION BOUNDARY:
 *   The adapter returns observations only. The kernel owns all state
 *   transitions, validated against a legal transition matrix.
 *
 * Idempotent — safe to call multiple times.
 */
export async function reconcileBindingWithProvider(bindingId: string): Promise<{
  status: "in_sync" | "transitioned" | "no_action" | "stale_observation" | "error";
  observedState?: string;
  transition?: { from: string; to: string };
  error?: string;
}> {
  try {
    // Step 1: Resolve the adapter from the persisted binding's providerType
    const { resolveBindingAdapter } = await import("./registry");
    const { adapter, binding: bindingSummary } = await resolveBindingAdapter(bindingId);

    // Step 2: Load the full binding + entitlement for the adapter call
    const fullBinding = await db.providerResourceBinding.findUnique({
      where: { id: bindingId },
      select: { id: true, entitlementId: true, providerType: true, providerResourceId: true, providerMetadata: true, status: true, provisioningState: true },
    });
    if (!fullBinding) {
      return { status: "error", error: "Binding not found" };
    }

    const entitlement = await db.connectivityEntitlement.findUnique({
      where: { id: fullBinding.entitlementId },
      include: { capability: true },
    });
    if (!entitlement) {
      return { status: "error", error: "Entitlement not found" };
    }

    // Capture the observed binding status BEFORE the adapter call.
    // This is used for stale-observation prevention in the transaction.
    const observedBindingStatus = fullBinding.status;

    // Step 3: Call the adapter's reconcile() — this is an OBSERVATION, not a mutation.
    // The adapter does NOT touch the database. It only reports what it sees at the provider.
    const adapterResult = await adapter.reconcile({
      entitlement: {
        id: entitlement.id,
        tenantId: entitlement.tenantId,
        subscriptionId: entitlement.subscriptionId,
        status: entitlement.status,
        capabilityType: entitlement.capability.type,
        capabilitySet: JSON.parse(entitlement.capabilitySet),
        policy: entitlement.policy ? JSON.parse(entitlement.policy) : null,
        validFrom: entitlement.validFrom,
        validUntil: entitlement.validUntil,
      },
      binding: {
        id: fullBinding.id,
        entitlementId: fullBinding.entitlementId,
        providerType: fullBinding.providerType,
        providerResourceId: fullBinding.providerResourceId,
        providerMetadata: fullBinding.providerMetadata ? JSON.parse(fullBinding.providerMetadata) : null,
        status: fullBinding.status,
        provisioningState: fullBinding.provisioningState,
      },
    });

    // Step 4: Map the observation to a kernel decision (target state + metadata).
    // The kernel validates the transition against the legal transition matrix.
    const decision = mapReconciliationResult(observedBindingStatus, adapterResult);

    // Step 5: ATOMIC COMMIT — perform the transition + metadata update in ONE transaction.
    // Lock the binding row with FOR UPDATE. Verify the status hasn't changed
    // since we observed it (stale-observation prevention).
    const txResult = await db.$transaction(async (tx) => {
      // Lock the binding row
      const lockedBinding: Array<{ id: string; status: string }> = await tx.$queryRaw`
        SELECT id, status FROM "ProviderResourceBinding" WHERE id = ${bindingId} FOR UPDATE
      `;
      if (lockedBinding.length === 0) {
        return { committed: false as const, reason: "Binding not found in transaction" };
      }

      const currentStatus = lockedBinding[0].status;

      // STALE OBSERVATION CHECK: if the binding's status changed since we observed it,
      // the adapter's observation is stale. Do NOT apply the transition.
      if (currentStatus !== observedBindingStatus) {
        return {
          committed: false as const,
          reason: `Stale observation: binding was "${observedBindingStatus}" when observed, now "${currentStatus}". Skipping — another worker changed it.`,
        };
      }

      // Apply the transition (if any) + metadata update atomically
      if (decision.targetBindingState) {
        // Guarded transition: only if the status is still what we observed
        const transitionResult = await tx.providerResourceBinding.updateMany({
          where: { id: bindingId, status: observedBindingStatus },
          data: {
            status: decision.targetBindingState,
            failureReason: decision.failureReason,
            reconciliationState: decision.reconciliationState,
            lastReconciledAt: new Date(),
          },
        });
        if (transitionResult.count === 0) {
          return { committed: false as const, reason: "Transition guard failed — concurrent modification" };
        }
        return {
          committed: true as const,
          transitioned: true,
          from: observedBindingStatus,
          to: decision.targetBindingState,
        };
      } else {
        // No state transition — just update reconciliation metadata
        await tx.providerResourceBinding.update({
          where: { id: bindingId },
          data: {
            reconciliationState: decision.reconciliationState,
            failureReason: decision.failureReason,
            lastReconciledAt: new Date(),
          },
        });
        return { committed: true as const, transitioned: false };
      }
    }, { timeout: 30000, maxWait: 15000 });

    if (!txResult.committed) {
      if (txResult.reason.includes("Stale observation")) {
        return { status: "stale_observation", error: txResult.reason };
      }
      return { status: "no_action", error: txResult.reason };
    }

    if (txResult.transitioned) {
      return {
        status: "transitioned",
        observedState: adapterResult.observedState,
        transition: { from: txResult.from, to: txResult.to },
      };
    }

    return { status: "in_sync", observedState: adapterResult.observedState };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("connectivity.reconcile_binding_failed", { bindingId, error: errorMsg });
    return { status: "error", error: errorMsg };
  }
}
