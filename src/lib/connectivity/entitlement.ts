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
// Phase 2C.2.1: Reconciliation Boundary — Adapter Reports, Kernel Decides
// ---------------------------------------------------------------------------

/**
 * Phase 2C.2.1: Reconcile a single binding with its provider.
 *
 * RECONCILIATION BOUNDARY:
 *   The adapter returns observations only. It MUST NOT directly mutate
 *   ProviderResourceBinding state. The kernel owns all state transitions.
 *
 * Mapping from ReconciliationResult to binding state transitions:
 *
 *   in_sync            → no transition (binding stays as-is)
 *   drift_detected     → transition per recommendedBindingState (e.g., DEGRADED)
 *   resource_missing   → transition to FAILED
 *   failed_retryable   → keep current durable state + mark RECONCILIATION_REQUIRED
 *   failed_permanent   → transition to FAILED + mark for manual intervention
 *
 * This function is idempotent — safe to call multiple times.
 */
export async function reconcileBindingWithProvider(bindingId: string): Promise<{
  status: "in_sync" | "transitioned" | "no_action" | "error";
  observedState?: string;
  transition?: { from: string; to: string };
  error?: string;
}> {
  // Resolve the adapter from the persisted binding's providerType
  const { resolveBindingAdapter } = await import("./registry");
  const { adapter, binding } = await resolveBindingAdapter(bindingId);

  // Load the full entitlement for the adapter call
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

  // Call the adapter's reconcile() — this is an OBSERVATION, not a mutation
  const result = await adapter.reconcile({
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

  // KERNEL OWNS THE STATE TRANSITION — based on the adapter's observation
  switch (result.status) {
    case "in_sync": {
      // No drift — mark reconciled
      await db.providerResourceBinding.updateMany({
        where: { id: bindingId },
        data: { reconciliationState: "RECONCILED", lastReconciledAt: new Date() },
      });
      return { status: "in_sync", observedState: result.observedState };
    }

    case "drift_detected": {
      // Transition per the adapter's recommendation
      const targetState = result.recommendedBindingState as BindingState | undefined;
      if (targetState) {
        const transitionResult = await transitionBinding({
          bindingId,
          toState: targetState,
          reason: result.details ?? "Provider drift detected",
        });
        await db.providerResourceBinding.updateMany({
          where: { id: bindingId },
          data: { reconciliationState: "RECONCILED", lastReconciledAt: new Date() },
        });
        return {
          status: transitionResult.transitioned ? "transitioned" : "no_action",
          observedState: result.observedState,
          transition: transitionResult.transitioned
            ? { from: binding.status, to: targetState }
            : undefined,
        };
      }
      // No recommended state — just mark for reconciliation
      await db.providerResourceBinding.updateMany({
        where: { id: bindingId },
        data: { reconciliationState: "RECONCILIATION_REQUIRED" },
      });
      return { status: "no_action", observedState: result.observedState };
    }

    case "resource_missing": {
      // Provider no longer has the resource → transition to FAILED
      const transitionResult = await transitionBinding({
        bindingId,
        toState: BINDING_STATES.FAILED,
        reason: "Provider resource missing — reconcile() reported resource_missing",
      });
      await db.providerResourceBinding.updateMany({
        where: { id: bindingId },
        data: { reconciliationState: "RECONCILED", lastReconciledAt: new Date() },
      });
      return {
        status: transitionResult.transitioned ? "transitioned" : "no_action",
        observedState: result.observedState,
        transition: transitionResult.transitioned
          ? { from: binding.status, to: BINDING_STATES.FAILED }
          : undefined,
      };
    }

    case "failed_retryable": {
      // Keep current durable state — retry later
      await db.providerResourceBinding.updateMany({
        where: { id: bindingId },
        data: { reconciliationState: "RECONCILIATION_REQUIRED", failureReason: result.details },
      });
      return { status: "no_action", error: result.details };
    }

    case "failed_permanent": {
      // Transition to FAILED — manual intervention required
      const transitionResult = await transitionBinding({
        bindingId,
        toState: BINDING_STATES.FAILED,
        reason: `Permanent reconciliation failure: ${result.details ?? "unknown"}`,
      });
      await db.providerResourceBinding.updateMany({
        where: { id: bindingId },
        data: { reconciliationState: "RECONCILIATION_REQUIRED", failureReason: result.details },
      });
      return {
        status: transitionResult.transitioned ? "transitioned" : "no_action",
        observedState: result.observedState,
        transition: transitionResult.transitioned
          ? { from: binding.status, to: BINDING_STATES.FAILED }
          : undefined,
        error: result.details,
      };
    }

    default:
      return { status: "error", error: `Unknown reconciliation status: ${result.status}` };
  }
}
