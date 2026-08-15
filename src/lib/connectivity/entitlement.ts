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
  /** Phase 2C.3: Resource type within the provider (e.g., "hotspot_user", "radius_subscriber") */
  resourceType?: string;
  /** Phase 2C.3.1: Provider instance — the specific infrastructure endpoint */
  providerInstanceId?: string;
  providerMetadata?: Record<string, unknown>;
  userId?: string;
}): Promise<{ id: string; status: string }> {
  // Phase 2C.3.1: If a providerInstanceId is supplied, verify it belongs to
  // the same tenant as the entitlement and matches the providerType.
  if (input.providerInstanceId) {
    const entitlement = await db.connectivityEntitlement.findUnique({
      where: { id: input.entitlementId },
      select: { tenantId: true },
    });
    if (!entitlement) {
      throw new AppError("not_found", "Entitlement not found", 404, "Cannot create binding — entitlement not found.");
    }
    const instance = await db.connectivityProviderInstance.findUnique({
      where: { id: input.providerInstanceId },
      select: { tenantId: true, providerType: true, status: true },
    });
    if (!instance) {
      throw new AppError("not_found", "Provider instance not found", 404, "Provider instance does not exist.");
    }
    // Tenant isolation: the instance must belong to the same tenant
    if (instance.tenantId !== entitlement.tenantId) {
      throw new AppError(
        "authorization",
        "Cross-tenant provider instance access denied",
        403,
        "The provider instance belongs to a different tenant.",
      );
    }
    // Type match: the instance's providerType must match the binding's providerType
    if (instance.providerType !== input.providerType) {
      throw new AppError(
        "validation",
        "Provider type mismatch",
        400,
        `Instance providerType is "${instance.providerType}" but binding providerType is "${input.providerType}".`,
      );
    }
    // Instance must be active
    if (instance.status !== "active") {
      throw new AppError(
        "conflict",
        "Provider instance not active",
        409,
        `Provider instance status is "${instance.status}". Only "active" instances can be used.`,
      );
    }
  }

  const binding = await db.providerResourceBinding.create({
    data: {
      entitlementId: input.entitlementId,
      providerType: input.providerType,
      resourceType: input.resourceType ?? null,
      providerInstanceId: input.providerInstanceId ?? null,
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
    // Phase 2C.3.2: Use the canonical runtime resolver.
    // This validates tenant isolation, type match, and instance status
    // at RUNTIME — not just at creation time.
    const { adapter, binding: bindingInput, entitlement: entitlementInput } = await resolveBindingRuntime(bindingId);

    // Capture the observed binding status BEFORE the adapter call.
    const observedBindingStatus = bindingInput.status;

    // Call the adapter's reconcile() — this is an OBSERVATION, not a mutation.
    // The adapter receives the full binding input INCLUDING providerInstanceId
    // and providerInstanceConfiguration.
    const adapterResult = await adapter.reconcile({
      entitlement: entitlementInput,
      binding: bindingInput,
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

// ---------------------------------------------------------------------------
// Phase 2C.3.1: Provider Instance Management
// ---------------------------------------------------------------------------

/**
 * Phase 2C.3.1: Create a connectivity provider instance.
 *
 * A provider instance represents a specific infrastructure endpoint
 * (e.g., "Accra Router 01", "Kumasi Router 02").
 *
 * Secrets/credentials MUST NOT be stored in the database. Use configurationKey
 * to reference a secrets manager key. The configuration field is for non-secret
 * configuration only (endpoint URL, API version, region, etc.).
 */
export async function createProviderInstance(input: {
  tenantId: string;
  providerType: string;
  name: string;
  configuration?: Record<string, unknown>;
  configurationKey?: string;
  userId?: string;
}): Promise<{ id: string; status: string }> {
  const instance = await db.connectivityProviderInstance.create({
    data: {
      tenantId: input.tenantId,
      providerType: input.providerType,
      name: input.name,
      status: "active",
      configuration: input.configuration ? JSON.stringify(input.configuration) : null,
      configurationKey: input.configurationKey ?? null,
    },
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "connectivity.provider_instance_created",
    entity: "connectivity_provider_instance",
    entityId: instance.id,
    detail: { providerType: input.providerType, name: input.name },
  });

  logger.info("connectivity.provider_instance_created", {
    instanceId: instance.id, tenantId: input.tenantId,
    providerType: input.providerType, name: input.name,
  });

  return { id: instance.id, status: instance.status };
}

/**
 * Phase 2C.3.1: List provider instances for a tenant.
 */
export async function listProviderInstances(tenantId: string, providerType?: string) {
  return db.connectivityProviderInstance.findMany({
    where: {
      tenantId,
      ...(providerType ? { providerType } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Phase 2C.3.1: Get a provider instance by ID, with tenant authorization.
 */
export async function getProviderInstance(instanceId: string, tenantId: string) {
  const instance = await db.connectivityProviderInstance.findUnique({
    where: { id: instanceId },
  });
  if (!instance || instance.tenantId !== tenantId) {
    throw new AppError("not_found", "Provider instance not found", 404, "Provider instance not found or access denied.");
  }
  return instance;
}

/**
 * Phase 2C.3.1: Resolve the provider instance for a binding.
 *
 * Returns the provider instance (if set) along with the adapter.
 * This is the full resolution path:
 *   ProviderResourceBinding.providerInstanceId → ConnectivityProviderInstance
 *   ProviderResourceBinding.providerType → ConnectivityProviderAdapter (via registry)
 */
export async function resolveBindingWithInstance(bindingId: string): Promise<{
  adapter: import("./adapter").ConnectivityProviderAdapter;
  binding: { id: string; providerType: string; providerInstanceId: string | null; status: string; providerResourceId: string | null };
  providerInstance: { id: string; tenantId: string; providerType: string; name: string; status: string } | null;
}> {
  const { db } = await import("@/lib/db");
  const { resolveBindingAdapter } = await import("./registry");

  const { adapter, binding } = await resolveBindingAdapter(bindingId);

  let providerInstance = null;
  if (binding.providerInstanceId) {
    // Load the instance — note: we don't check tenant here because the binding
    // was already authorized at creation time. The binding's entitlement has
    // the tenantId, and the instance was verified to belong to that tenant.
    const instance = await db.connectivityProviderInstance.findUnique({
      where: { id: binding.providerInstanceId },
      select: { id: true, tenantId: true, providerType: true, name: true, status: true },
    });
    if (instance) {
      providerInstance = instance;
    }
  }

  return { adapter, binding, providerInstance };
}

// ---------------------------------------------------------------------------
// Phase 2C.3.2: Canonical Runtime Resolution
// ---------------------------------------------------------------------------

/**
 * Phase 2C.3.2: The canonical runtime resolver.
 *
 * This is the ONLY correct way to resolve a binding's full runtime context:
 *   1. Load the ProviderResourceBinding
 *   2. Load the associated ConnectivityEntitlement (for tenantId)
 *   3. Load the ConnectivityProviderInstance (if providerInstanceId is set)
 *   4. Verify tenant isolation: instance.tenantId === entitlement.tenantId
 *   5. Verify type match: instance.providerType === binding.providerType
 *   6. Verify instance status: must be "active"
 *   7. Resolve the adapter through the registry
 *
 * This resolver does NOT rely on creation-time authorization. It validates
 * the CURRENT relationship every time. If the instance's ownership, type,
 * or status has changed since binding creation, the resolver fails closed.
 *
 * Returns the full runtime context: adapter, binding, entitlement, providerInstance.
 */
export async function resolveBindingRuntime(bindingId: string): Promise<{
  adapter: import("./adapter").ConnectivityProviderAdapter;
  binding: import("./adapter").ProviderResourceBindingInput;
  entitlement: import("./adapter").ConnectivityEntitlementInput;
  providerInstance: {
    id: string;
    tenantId: string;
    providerType: string;
    name: string;
    status: string;
    configuration: Record<string, unknown> | null;
    configurationKey: string | null;
  } | null;
}> {
  const { resolveBindingAdapter } = await import("./registry");

  // Step 1: Load the binding (includes providerInstanceId from 2C.3.1)
  const { adapter, binding: bindingSummary } = await resolveBindingAdapter(bindingId);

  // Step 2: Load the full binding with all fields needed for the adapter input
  const fullBinding = await db.providerResourceBinding.findUnique({
    where: { id: bindingId },
    select: {
      id: true, entitlementId: true, providerType: true,
      providerResourceId: true, providerMetadata: true,
      status: true, provisioningState: true,
      providerInstanceId: true,
    },
  });
  if (!fullBinding) {
    throw new Error(`ProviderResourceBinding not found: ${bindingId}`);
  }

  // Step 3: Load the entitlement (for tenantId + capability info)
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: fullBinding.entitlementId },
    include: { capability: true },
  });
  if (!entitlement) {
    throw new Error(`Entitlement not found for binding ${bindingId}`);
  }

  // Step 4: Load the provider instance (if set)
  let providerInstance: {
    id: string; tenantId: string; providerType: string;
    name: string; status: string;
    configuration: Record<string, unknown> | null;
    configurationKey: string | null;
  } | null = null;

  if (fullBinding.providerInstanceId) {
    const instance = await db.connectivityProviderInstance.findUnique({
      where: { id: fullBinding.providerInstanceId },
      select: { id: true, tenantId: true, providerType: true, name: true, status: true, configuration: true, configurationKey: true },
    });

    if (!instance) {
      throw new Error(
        `Provider instance not found: ${fullBinding.providerInstanceId} (binding ${bindingId}). ` +
        `The instance may have been deleted after binding creation.`,
      );
    }

    // Step 5: Runtime tenant isolation — verify CURRENT ownership
    if (instance.tenantId !== entitlement.tenantId) {
      throw new Error(
        `Cross-tenant provider instance access denied: binding ${bindingId} belongs to tenant ` +
        `"${entitlement.tenantId}" but instance "${instance.id}" belongs to tenant "${instance.tenantId}".`,
      );
    }

    // Step 6: Runtime type match — verify CURRENT providerType
    if (instance.providerType !== fullBinding.providerType) {
      throw new Error(
        `Provider type mismatch: binding providerType is "${fullBinding.providerType}" ` +
        `but instance "${instance.id}" has providerType "${instance.providerType}".`,
      );
    }

    // Step 7: Instance status — must be active
    if (instance.status !== "active") {
      throw new Error(
        `Provider instance "${instance.id}" status is "${instance.status}". ` +
        `Only "active" instances can be used for runtime operations.`,
      );
    }

    providerInstance = {
      ...instance,
      configuration: instance.configuration ? JSON.parse(instance.configuration) : null,
    };
  }

  // Build the adapter inputs
  const bindingInput: import("./adapter").ProviderResourceBindingInput = {
    id: fullBinding.id,
    entitlementId: fullBinding.entitlementId,
    providerType: fullBinding.providerType,
    providerResourceId: fullBinding.providerResourceId,
    providerMetadata: fullBinding.providerMetadata ? JSON.parse(fullBinding.providerMetadata) : null,
    status: fullBinding.status,
    provisioningState: fullBinding.provisioningState,
    providerInstanceId: fullBinding.providerInstanceId,
    providerInstanceConfiguration: providerInstance?.configuration ?? null,
  };

  const entitlementInput: import("./adapter").ConnectivityEntitlementInput = {
    id: entitlement.id,
    tenantId: entitlement.tenantId,
    subscriptionId: entitlement.subscriptionId,
    status: entitlement.status,
    capabilityType: entitlement.capability.type,
    capabilitySet: JSON.parse(entitlement.capabilitySet),
    policy: entitlement.policy ? JSON.parse(entitlement.policy) : null,
    validFrom: entitlement.validFrom,
    validUntil: entitlement.validUntil,
  };

  return { adapter, binding: bindingInput, entitlement: entitlementInput, providerInstance };
}

// ---------------------------------------------------------------------------
// Phase 2C.4.5: Durable Provisioning Claim with Lease + Attempt Identity
// Phase 2C.4.6: Lease Ownership Enforcement During External Operations
// ---------------------------------------------------------------------------

/**
 * Phase 2C.4.5: Lease duration for provisioning claims (5 minutes).
 * After this time, another worker may take over the claim.
 *
 * Phase 2C.4.6: This duration MUST exceed providerOperationTimeoutMs so
 * that a single, non-crashed worker can always complete a bounded provider
 * operation before its lease naturally expires. The heartbeat
 * (provisioningHeartbeatIntervalMs) extends the lease well before it
 * expires, so an actively-running worker is never subject to takeover.
 *
 * Mutable for testing via _setLeaseDurationForTesting() — production code
 * must not change this value.
 */
let provisioningLeaseMs = 5 * 60 * 1000;

/**
 * Phase 2C.4.6: How often the provisioning worker extends its lease while a
 * provider operation is in flight. The interval (60s) is far shorter than the
 * lease (5 min), so even a couple of missed heartbeats cannot let the lease
 * expire while the worker is genuinely alive.
 *
 * Mutable for testing via _setHeartbeatIntervalForTesting() — production code
 * must not change this value.
 */
let provisioningHeartbeatIntervalMs = 60 * 1000;

/**
 * Phase 2C.4.6: Bounded maximum duration for a single provider operation.
 *
 * This is a hard ceiling on how long provisionBinding() will wait for
 * adapter.provision() to resolve. It MUST be strictly less than
 * PROVISIONING_LEASE_MS so that a non-crashed worker always completes (or
 * times out) before its initial lease could possibly expire, making
 * mid-operation takeover impossible without a crash.
 *
 * If a provider operation exceeds this bound, it is treated as a failure and
 * finalized via the claim-guarded FAILED transition. The underlying provider
 * call (if still running) cannot be cancelled, but its eventual result is
 * discarded — the claim-guarded finalization refuses to apply a stale result.
 *
 * Mutable for testing via _setOperationTimeoutForTesting() — production code
 * must not change this value.
 */
let providerOperationTimeoutMs = 4 * 60 * 1000;

/**
 * Phase 2C.4.5: Atomic provisioning claim with attempt identity + lease.
 *
 * Two claim paths:
 *   1. UNBOUND → PROVISIONING (initial claim)
 *   2. PROVISIONING + expired lease → PROVISIONING (lease takeover)
 *
 * In both cases, a new provisioningAttemptId is generated and claimExpiresAt
 * is set. Only the worker holding the attemptId may execute provider
 * operations or finalize the binding.
 *
 * A stale worker (whose attemptId no longer matches) cannot mutate the binding
 * — the finalization writes are guarded by WHERE provisioningAttemptId = X.
 *
 * Returns:
 *   { claimed: true, attemptId } — this worker owns the provisioning attempt
 *   { claimed: false, currentStatus } — another active worker owns it
 */
export async function claimProvisioning(bindingId: string): Promise<{
  claimed: boolean;
  attemptId?: string;
  currentStatus?: string;
}> {
  const now = new Date();
  const attemptId = `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const claimExpiresAt = new Date(now.getTime() + provisioningLeaseMs);

  // Path 1: UNBOUND → PROVISIONING (initial claim)
  const initialClaim = await db.providerResourceBinding.updateMany({
    where: { id: bindingId, status: BINDING_STATES.UNBOUND },
    data: {
      status: BINDING_STATES.PROVISIONING,
      provisioningState: "PENDING",
      provisioningAttemptId: attemptId,
      claimExpiresAt,
    },
  });

  if (initialClaim.count > 0) {
    logger.info("connectivity.provisioning_claimed", { bindingId, attemptId, claimType: "initial" });
    return { claimed: true, attemptId };
  }

  // Path 2: PROVISIONING + expired lease → takeover
  // The current claim's lease has expired — another worker may take over.
  const current = await db.providerResourceBinding.findUnique({
    where: { id: bindingId },
    select: { status: true, claimExpiresAt: true, provisioningAttemptId: true },
  });

  if (!current) {
    return { claimed: false, currentStatus: "not_found" };
  }

  // If the current status is not PROVISIONING, we can't claim (it's BOUND, FAILED, etc.)
  if (current.status !== BINDING_STATES.PROVISIONING) {
    return { claimed: false, currentStatus: current.status };
  }

  // Check if the lease has expired
  if (current.claimExpiresAt && current.claimExpiresAt > now) {
    // Lease is still active — another worker owns it
    return { claimed: false, currentStatus: current.status };
  }

  // Lease has expired — take over atomically.
  //
  // Phase 2C.4.6: A takeover is a durable signal that the previous attempt's
  // outcome is UNKNOWN — the previous worker may have created a resource at
  // the provider, or it may have failed, or it may have crashed before any
  // side effect. We mark the binding RECONCILIATION_REQUIRED so that:
  //   - the new owner's adapter.provision() (which does GET-before-PUT) is
  //     treated as the reconciliation, and
  //   - any reconciler observing the binding knows the previous attempt was
  //     superseded and its outcome was never durably finalized.
  //
  // Phase 2C.4.8: The takeover UPDATE is conditional on the OBSERVED old
  // attemptId (current.provisioningAttemptId), not just on the lease being
  // expired. This closes the ABA problem: if another worker took over
  // between our read and our write (changing the attemptId), our UPDATE
  // matches zero rows and we return claimed=false, forcing a re-read.
  // The lease expiry alone is NOT the fence — the (attemptId, expiry) pair
  // is the fence, ensuring the takeover is based on the exact observed state.
  const takeoverClaim = await db.providerResourceBinding.updateMany({
    where: {
      id: bindingId,
      status: BINDING_STATES.PROVISIONING,
      // Phase 2C.4.8: condition on the OBSERVED old attemptId (ABA fence).
      // Prisma generates "provisioningAttemptId" = <value> or IS NULL.
      provisioningAttemptId: current.provisioningAttemptId,
      // Only take over if the lease has expired (or is null — legacy)
      OR: [
        { claimExpiresAt: { lt: now } },
        { claimExpiresAt: null },
      ],
    },
    data: {
      provisioningAttemptId: attemptId,
      claimExpiresAt,
      // Phase 2C.4.6: Durable signal — previous attempt outcome is unknown.
      reconciliationState: "RECONCILIATION_REQUIRED",
    },
  });

  if (takeoverClaim.count > 0) {
    logger.warn("connectivity.provisioning_claimed_takeover", {
      bindingId, attemptId, claimType: "takeover",
      previousAttemptId: current.provisioningAttemptId,
      message: "Lease takeover — previous attempt outcome is unknown. Binding marked RECONCILIATION_REQUIRED.",
    });
    return { claimed: true, attemptId };
  }

  // Another worker took over between our read and write
  return { claimed: false, currentStatus: current.status };
}

/**
 * Phase 2C.4.5: Claim-guarded finalization.
 *
 * Transitions the binding to a new state ONLY if the caller holds the
 * current provisioning attempt. This prevents a stale worker from
 * mutating the binding after its lease has expired and another worker
 * has taken over.
 *
 * WHERE id = bindingId
 *   AND provisioningAttemptId = attemptId
 *   AND status = PROVISIONING
 *
 * Phase 2C.4.6: A successful (count=1) finalization is a CLEAN outcome —
 * the binding has reached BOUND or FAILED through the legitimate claim
 * holder. Any prior RECONCILIATION_REQUIRED marker (e.g. from a takeover)
 * is cleared, because the outcome is now durably known.
 */
async function claimGuardedTransition(input: {
  bindingId: string;
  attemptId: string;
  toState: BindingState;
  providerResourceId?: string;
  providerMetadata?: Record<string, unknown>;
  provisioningState?: string;
  reason?: string;
}): Promise<{ transitioned: boolean }> {
  const updateData: Record<string, unknown> = {
    status: input.toState,
    failureReason: input.reason ?? null,
    provisioningAttemptId: null, // Clear the claim after finalization
    claimExpiresAt: null,
    // Phase 2C.4.6: Clean finalization clears any prior reconciliation flag.
    reconciliationState: null,
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
    where: {
      id: input.bindingId,
      provisioningAttemptId: input.attemptId,
      status: BINDING_STATES.PROVISIONING,
    },
    data: updateData,
  });

  if (result.count === 0) {
    // The caller's attemptId no longer matches — lease was taken over by another worker
    logger.warn("connectivity.provisioning_stale_worker", {
      bindingId: input.bindingId,
      attemptId: input.attemptId,
      message: "CRITICAL: Stale worker attempted finalization — claim was taken over by another worker.",
    });
    return { transitioned: false };
  }

  return { transitioned: true };
}

// ---------------------------------------------------------------------------
// Phase 2C.4.6: Lease Ownership Enforcement During External Operations
// ---------------------------------------------------------------------------

/**
 * Phase 2C.4.6: Verify that the caller still holds the active provisioning
 * claim IMMEDIATELY before invoking the provider adapter.
 *
 * This is the "pre-provider ownership check". It closes the race where a
 * worker's lease expired (or was taken over) between claimProvisioning() and
 * adapter.provision(). Without this check, a stale worker could begin a
 * provider side effect after another worker had already taken over.
 *
 * Invariant enforced:
 *   ACTIVE CLAIM (attemptId matches + status=PROVISIONING + lease not expired)
 *     → provider operation MAY begin
 *   CLAIM NO LONGER ACTIVE
 *     → provider operation MUST NOT begin (returns owns: false)
 *
 * This is a READ (findUnique) — it does not mutate the binding. The
 * authoritative ownership gate is the conditional UPDATE in
 * claimGuardedTransition / extendProvisioningLease; this read is the
 * fast-path guard that prevents issuing a provider call when ownership has
 * already visibly been lost.
 */
export async function verifyProvisioningOwnership(
  bindingId: string,
  attemptId: string,
): Promise<{
  owns: boolean;
  status?: string;
  claimExpiresAt?: Date | null;
  reason?: string;
}> {
  const binding = await db.providerResourceBinding.findUnique({
    where: { id: bindingId },
    select: {
      status: true,
      provisioningAttemptId: true,
      claimExpiresAt: true,
    },
  });

  if (!binding) {
    return { owns: false, status: "not_found", reason: "Binding not found" };
  }

  if (binding.status !== BINDING_STATES.PROVISIONING) {
    return {
      owns: false,
      status: binding.status,
      reason: `Binding is no longer PROVISIONING (status: ${binding.status})`,
    };
  }

  if (binding.provisioningAttemptId !== attemptId) {
    return {
      owns: false,
      status: binding.status,
      reason: "Claim was taken over by another worker (attemptId mismatch)",
    };
  }

  const now = new Date();
  if (binding.claimExpiresAt && binding.claimExpiresAt < now) {
    return {
      owns: false,
      status: binding.status,
      claimExpiresAt: binding.claimExpiresAt,
      reason: "Lease has expired",
    };
  }

  return { owns: true, claimExpiresAt: binding.claimExpiresAt };
}

/**
 * Phase 2C.4.6: Extend (heartbeat) the provisioning lease while a provider
 * operation is in flight.
 *
 * This is a conditional UPDATE guarded by the caller's attemptId. It is the
 * authoritative ownership gate during a long-running operation:
 *   - If the caller still holds the attempt AND the binding is still
 *     PROVISIONING, the lease is extended and no takeover is possible.
 *   - If another worker has taken over (attemptId changed) or the binding
 *     moved out of PROVISIONING, the update matches zero rows and the caller
 *     learns it has lost ownership.
 *
 * Combined with the bounded PROVIDER_OPERATION_TIMEOUT_MS, this guarantees
 * that a non-crashed worker never loses its lease while legitimately
 * executing a provider operation, and a crashed worker's lease expires
 * naturally so another worker can take over.
 */
export async function extendProvisioningLease(
  bindingId: string,
  attemptId: string,
): Promise<{ extended: boolean; reason?: string; newExpiresAt?: Date }> {
  const now = new Date();
  const newExpiresAt = new Date(Date.now() + provisioningLeaseMs);

  // Phase 2C.4.8: The heartbeat (lease extension) is conditional on the lease
  // NOT being expired. This closes the heartbeat-vs-takeover race:
  //
  //   Without this check, a delayed heartbeat (firing after the lease expired)
  //   could "resurrect" an expired lease by setting claimExpiresAt to a future
  //   value. This would block a concurrent takeover that legitimately observed
  //   the expired lease.
  //
  //   With this check, a delayed heartbeat fails (0 rows) once the lease has
  //   expired. The worker detects the loss (heartbeatLost=true) and discards
  //   its result. The takeover can proceed unimpeded.
  //
  //   The lease and the heartbeat are now mutually exclusive with the takeover:
  //     - lease NOT expired → heartbeat succeeds (extends), takeover fails
  //     - lease IS expired  → heartbeat fails, takeover succeeds
  //
  // Note: a null claimExpiresAt (legacy binding) is treated as expired — the
  // heartbeat cannot extend it, forcing the worker through claimProvisioning's
  // takeover path (which sets a fresh non-null lease).
  const result = await db.providerResourceBinding.updateMany({
    where: {
      id: bindingId,
      provisioningAttemptId: attemptId,
      status: BINDING_STATES.PROVISIONING,
      // Phase 2C.4.8: only extend if the lease is NOT expired.
      // In SQL: claimExpiresAt > now(). NULL > now() evaluates to NULL (not
      // true), so legacy bindings with null claimExpiresAt are NOT extended.
      claimExpiresAt: { gt: now },
    },
    data: {
      claimExpiresAt: newExpiresAt,
    },
  });

  if (result.count === 0) {
    return {
      extended: false,
      reason: "Claim was taken over, binding is no longer PROVISIONING, or lease has expired",
    };
  }

  return { extended: true, newExpiresAt };
}

/**
 * Phase 2C.4.6: Test-only override of the heartbeat interval.
 *
 * Production code MUST NOT call this. Returns a restore function so tests can
 * reset the value after they finish. This keeps the production 60s heartbeat
 * untouched while allowing tests to exercise the lease-loss-during-operation
 * race in milliseconds rather than minutes.
 */
export function _setHeartbeatIntervalForTesting(ms: number): () => void {
  const previous = provisioningHeartbeatIntervalMs;
  provisioningHeartbeatIntervalMs = ms;
  return () => {
    provisioningHeartbeatIntervalMs = previous;
  };
}

/**
 * Phase 2C.4.6: Test-only override of the lease duration.
 *
 * Production code MUST NOT call this. Returns a restore function so tests can
 * exercise the "heartbeat keeps the lease alive past its natural expiry"
 * guarantee in seconds rather than minutes.
 */
export function _setLeaseDurationForTesting(ms: number): () => void {
  const previous = provisioningLeaseMs;
  provisioningLeaseMs = ms;
  return () => {
    provisioningLeaseMs = previous;
  };
}

/**
 * Phase 2C.4.6: Test-only override of the provider operation timeout.
 *
 * Production code MUST NOT call this. Returns a restore function so tests can
 * exercise the bounded-operation guarantee in milliseconds rather than minutes.
 */
export function _setOperationTimeoutForTesting(ms: number): () => void {
  const previous = providerOperationTimeoutMs;
  providerOperationTimeoutMs = ms;
  return () => {
    providerOperationTimeoutMs = previous;
  };
}

// ---------------------------------------------------------------------------
// Phase 2C.4.6 — Architectural Distinction: Lease Fencing vs. Provider-Side
// Convergence
// ---------------------------------------------------------------------------
//
// Provisioning safety is provided by TWO INDEPENDENT layers. Neither layer
// alone is sufficient; together they establish the full invariant.
//
// LAYER 1 — LEASE FENCING (local coordination, this kernel):
//
//   The PostgreSQL provisioning lease (provisioningAttemptId + claimExpiresAt)
//   guarantees that, under NORMAL operation, only ONE worker begins a
//   provisioning attempt. It also guarantees that a STALE worker (whose lease
//   expired or was taken over) cannot FINALIZE the binding — the
//   claim-guarded transition refuses to apply a stale attemptId.
//
//   What it CANNOT guarantee:
//     "A worker whose lease later expires cannot continue an already-started
//      external operation."
//
//   If worker A sends a PUT to RouterOS and then loses its DB lease (network
//   partition, crash, GC pause), worker B may take over and also send a PUT.
//   The DB lease cannot make either in-flight HTTP request disappear. The
//   network, not the application timeout, determines when the external system
//   stops receiving a request.
//
//   So the lease provides:
//     ✅ only one worker normally starts provisioning
//     ✅ stale workers cannot write local state (claim-guarded finalization)
//     ❌ stale workers cannot mutate the external provider
//
// LAYER 2 — PROVIDER-SIDE CONVERGENCE (external safety, the adapter + client):
//
//   Because a DB lease cannot fence an already-started external operation,
//   provider-side safety must be INDEPENDENT of the lease. The create
//   operation must be CONVERGENT: replay, concurrent, or uncertain attempts
//   must all resolve to exactly ONE external resource, bound by the stable
//   binding identity (the HotSpot username).
//
//   The RouterOSProviderClient.createResource() implements three convergence
//   paths, all keyed on the stable username:
//
//     1. GET by username → if exists, return it (idempotent — no PUT needed).
//        This handles: replay, retry, takeover-after-crash, and the common
//        case where worker B's GET finds the resource worker A created.
//
//     2. PUT → CONFLICT (409): another worker created the resource between
//        our GET and PUT. Reconcile: GET by username → return the existing
//        resource. This is the core concurrent-PUT race the lease cannot
//        prevent — both workers did GET (absent), both issued PUT, the second
//        conflicts. The resource exists; we converge on it.
//
//     3. PUT → TIMEOUT/RETRYABLE: uncertain outcome (the request may or may
//        not have reached the router). Reconcile: GET by username → if found,
//        return it; if absent, one controlled PUT retry.
//
//   In all three paths, two concurrent workers converge on the SAME external
//   resource. No duplicate RouterOS user is ever created. The binding's
//   providerResourceId is set to the RouterOS .id of that single resource.
//
// THE COMBINED INVARIANT:
//
//   Normal operation:  the lease ensures only one worker starts → one PUT →
//   one resource. The convergence layer is a no-op (GET finds absence, PUT
//   succeeds).
//
//   Failure/recovery:  the lease may let two workers believe they own
//   provisioning (A's lease expired while A was in-flight, B took over). Both
//   may issue provider operations. The convergence layer guarantees they
//   resolve to ONE external resource. The claim-guarded finalization
//   guarantees only ONE worker finalizes the binding to that resource. The
//   other worker's result is discarded (claim_lost) — but the external state
//   is consistent because the convergence layer already bound both to the
//   same resource.
//
//   This is why provider-side convergence is an INDEPENDENT layer: even if the
//   lease layer fails to prevent concurrent provider operations, the
//   provider layer guarantees no duplicate external resource is created.
// ---------------------------------------------------------------------------

/**
 * Phase 2C.4.5 + 2C.4.6: Kernel-level provisioning orchestration with lease.
 *
 * This is the canonical way to provision a binding. The full sequence:
 *
 *   1. Resolve runtime context (adapter, binding, entitlement).
 *   2. If already BOUND → already_provisioned (idempotent).
 *   3. Atomic claim (UNBOUND → PROVISIONING, or lease takeover) with a unique
 *      attemptId + lease expiry. Only ONE worker wins.
 *   4. [2C.4.6] Pre-provider ownership verification — verify the claim is
 *      still active IMMEDIATELY before invoking the adapter. A stale worker
 *      that lost ownership MUST NOT begin a provider side effect.
 *   5. [2C.4.6] Start a heartbeat that extends the lease while the provider
 *      operation runs, so a non-crashed worker is never subject to takeover.
 *   6. [2C.4.6] Bounded provider operation — adapter.provision() is raced
 *      against PROVIDER_OPERATION_TIMEOUT_MS (< lease duration).
 *   7. [2C.4.6] If the heartbeat detected ownership loss during the operation,
 *      refuse to finalize — discard the provider result.
 *   8. Claim-guarded finalization (success → BOUND, failure → FAILED).
 *   9. [2C.4.6] NO silent failure swallowing — if the failure transition
 *      itself fails (claim taken over), emit a CRITICAL log and return
 *      claim_lost. The takeover has already marked the binding
 *      RECONCILIATION_REQUIRED as the durable signal.
 *
 * Invariants enforced:
 *   - Only the worker holding provisioningAttemptId may BEGIN a provider op
 *     (pre-provider ownership check) or FINALIZE one (claim-guarded write).
 *   - A non-crashed worker never loses its lease mid-operation (heartbeat +
 *     bounded timeout < lease duration).
 *   - A crashed worker's lease expires naturally, enabling takeover. The
 *     takeover marks the binding RECONCILIATION_REQUIRED because the previous
 *     attempt's outcome is unknown.
 *   - No failure path is silently swallowed.
 */
export async function provisionBinding(bindingId: string): Promise<{
  status: "success" | "failed_retryable" | "failed_permanent" | "already_provisioned" | "claim_lost";
  providerResourceId?: string;
  error?: string;
}> {
  // Step 1: Resolve the runtime context
  const { adapter, binding, entitlement } = await resolveBindingRuntime(bindingId);

  // Step 2: If already BOUND, return success (idempotent)
  if (binding.status === BINDING_STATES.BOUND) {
    return { status: "already_provisioned", providerResourceId: binding.providerResourceId ?? undefined };
  }

  // Step 3: Atomic claim (with lease + attempt identity)
  const claim = await claimProvisioning(bindingId);
  if (!claim.claimed) {
    return { status: "claim_lost", error: `Another worker owns the provisioning claim (status: ${claim.currentStatus})` };
  }

  const attemptId = claim.attemptId!;

  // Step 4 (Phase 2C.4.6): Pre-provider ownership verification.
  // Verify the claim is still active IMMEDIATELY before invoking the adapter.
  // This closes the race where the lease expired (or was taken over) between
  // claimProvisioning() and adapter.provision(). A stale worker that has lost
  // ownership MUST NOT begin a provider side effect.
  const ownership = await verifyProvisioningOwnership(bindingId, attemptId);
  if (!ownership.owns) {
    logger.warn("connectivity.provisioning_ownership_lost_pre_provider", {
      bindingId, attemptId, reason: ownership.reason, status: ownership.status,
    });
    return {
      status: "claim_lost",
      error: `Lost provisioning ownership before provider call: ${ownership.reason}`,
    };
  }

  // Step 5 (Phase 2C.4.6): Heartbeat — keep the lease alive while the provider
  // operation runs. If the heartbeat detects that ownership was lost (another
  // worker took over), we mark the attempt as superseded and refuse to
  // finalize any result the provider returns.
  //
  // The heartbeat is guarded by an inFlight flag: if a previous heartbeat's
  // lease-extension query is still in flight (e.g., under high DB latency),
  // subsequent ticks are SKIPPED rather than stacked. This prevents connection-
  // pool exhaustion when the heartbeat interval is shorter than the query
  // latency, while still extending the lease as often as the DB allows.
  let heartbeatLost = false;
  let heartbeatLostReason: string | null = null;
  let heartbeatInFlight = false;
  const heartbeatTimer = setInterval(async () => {
    if (heartbeatInFlight) return; // don't stack overlapping extension queries
    heartbeatInFlight = true;
    try {
      const ext = await extendProvisioningLease(bindingId, attemptId);
      if (!ext.extended) {
        heartbeatLost = true;
        heartbeatLostReason = ext.reason ?? "unknown";
        logger.error("connectivity.provisioning_lease_lost_during_operation", {
          bindingId, attemptId, reason: ext.reason,
          message: "CRITICAL: Lease lost during provider operation — result will be discarded.",
        });
      }
    } catch (e) {
      // A transient heartbeat error must not kill the in-flight operation;
      // the claim-guarded finalization will catch a genuine ownership loss.
      logger.warn("connectivity.provisioning_heartbeat_error", {
        bindingId, attemptId, error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      heartbeatInFlight = false;
    }
  }, provisioningHeartbeatIntervalMs);
  // Don't let the heartbeat timer keep the process alive on its own.
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  // Declared outside try so the catch block can read it for diagnostics.
  let timeoutFired = false;

  try {
    // Re-resolve the binding (it's now PROVISIONING with our attemptId)
    const { binding: updatedBinding, entitlement: updatedEntitlement } = await resolveBindingRuntime(bindingId);

    // Step 6 (Phase 2C.4.6): Bounded provider operation.
    // The operation is raced against providerOperationTimeoutMs (4 min),
    // which is strictly less than the lease (5 min). A non-crashed worker
    // therefore always completes (or times out) before its lease can expire,
    // making mid-operation takeover impossible without a crash.
    const result = await Promise.race([
      adapter.provision({ entitlement: updatedEntitlement, binding: updatedBinding }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          timeoutFired = true;
          reject(new Error(`Provider operation timed out after ${providerOperationTimeoutMs}ms`));
        }, providerOperationTimeoutMs);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);

    // Step 7 (Phase 2C.4.6): If the heartbeat detected ownership loss during
    // the operation, refuse to finalize — another worker now owns the binding.
    if (heartbeatLost) {
      logger.error("connectivity.provisioning_result_discarded_lease_lost", {
        bindingId, attemptId, reason: heartbeatLostReason,
        message: "Provider operation completed but lease was lost during operation — result discarded.",
      });
      return {
        status: "claim_lost",
        error: `Lease was lost during provider operation: ${heartbeatLostReason}`,
      };
    }

    if (result.status === "success") {
      // Step 8: Claim-guarded transition to BOUND
      const transitioned = await claimGuardedTransition({
        bindingId,
        attemptId,
        toState: BINDING_STATES.BOUND,
        providerResourceId: result.providerResourceId,
        providerMetadata: result.providerMetadata,
        provisioningState: "COMPLETED",
      });

      if (!transitioned.transitioned) {
        // Our lease was taken over by another worker — our result is stale
        logger.warn("connectivity.provisioning_result_stale", {
          bindingId, attemptId,
          message: "Provider operation succeeded but claim was taken over — result is stale.",
        });
        return { status: "claim_lost", error: "Claim was taken over before finalization" };
      }

      logger.info("connectivity.provisioning_succeeded", {
        bindingId, attemptId, providerResourceId: result.providerResourceId,
      });

      return { status: "success", providerResourceId: result.providerResourceId };
    } else {
      // Provisioning failed — claim-guarded transition to FAILED
      const transitioned = await claimGuardedTransition({
        bindingId,
        attemptId,
        toState: BINDING_STATES.FAILED,
        provisioningState: "FAILED",
        reason: result.error,
      });

      if (!transitioned.transitioned) {
        // Our lease was taken over — another worker is handling it now
        return { status: "claim_lost", error: "Claim was taken over before failure finalization" };
      }

      logger.warn("connectivity.provisioning_failed", {
        bindingId, attemptId, error: result.error, classification: result.status,
      });

      return { status: result.status, error: result.error };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Step 9 (Phase 2C.4.6): NO silent failure swallowing.
    // Attempt the claim-guarded FAILED transition. If it fails (count=0), the
    // claim was taken over by another worker — we could NOT durably record
    // this failure. This is a CRITICAL condition, not an ignored exception.
    // The binding remains PROVISIONING under a NEW attemptId, and the
    // takeover path in claimProvisioning() has already marked it
    // RECONCILIATION_REQUIRED as the durable signal.
    const failureTransition = await claimGuardedTransition({
      bindingId,
      attemptId,
      toState: BINDING_STATES.FAILED,
      provisioningState: "FAILED",
      reason: errorMsg,
    });

    if (failureTransition.transitioned) {
      // Failure was durably recorded.
      logger.warn("connectivity.provisioning_error", {
        bindingId, attemptId, error: errorMsg, timeoutFired,
      });
      return { status: "failed_permanent", error: errorMsg };
    }

    // CRITICAL: The failure could not be durably finalized — the claim was
    // taken over. The new owner will reconcile. We return claim_lost so the
    // caller knows this worker's outcome was NOT durably recorded.
    logger.error("connectivity.provisioning_failure_unfinalized", {
      bindingId, attemptId, error: errorMsg, timeoutFired,
      message: "CRITICAL: Provider operation failed but failure could not be durably recorded — claim was taken over. Binding marked RECONCILIATION_REQUIRED by takeover.",
    });
    return {
      status: "claim_lost",
      error: `Provider failed (${errorMsg}) but claim was taken over before failure finalization; marked RECONCILIATION_REQUIRED.`,
    };
  } finally {
    clearInterval(heartbeatTimer);
  }
}
