/**
 * Phase 12.4.4 — Operational Observability.
 *
 * This module establishes the operator-facing incident-trail model that ties
 * together all the correlation identifiers across the platform:
 *
 *   requestId          (API request — from x-request-id header)
 *     ↓
 *   tenantId           (who the customer is)
 *     ↓
 *   providerInstanceId (which infrastructure endpoint)
 *     ↓
 *   providerResourceId (which RouterOS hotspot user)
 *     ↓
 *   intentId           (what the user asked for)
 *     ↓
 *   decisionId         (what the system decided)
 *     ↓
 *   actionId           (what was executed)
 *     ↓
 *   providerKey        (the external idempotency correlation)
 *
 * Every provider operation should log enough of this chain to reconstruct an
 * incident trail without manually joining database tables.
 *
 * FIELD AVAILABILITY BY EXECUTION CONTEXT (Phase 12.4.4b.3)
 * ========================================================
 *
 * The ten correlation fields have different availability depending on which
 * execution path initiates the provider operation. This is NOT a deficiency —
 * it reflects the fundamental architecture:
 *
 * Connectivity control plane (executeAction → kernel-bridge → adapter):
 *   actionId          ✅  — from the ConnectivityAction record
 *   sessionId         ✅  — from the ConnectivitySession
 *   intentId          ✅  — from the action's intent link
 *   decisionId        ✅  — from the action's decision link
 *   tenantId          ✅  — enriched from ProtocolCapability.tenantId
 *   providerInstanceId ✅  — enriched from ProtocolCapability.providerInstanceId
 *   providerResourceId ✅  — enriched from bridge result
 *   bindingId         ✅  — enriched from bridge result
 *   requestId         ⛔  — intentionally absent: the control plane is triggered
 *                           by reevaluation events, not direct API requests.
 *                           The requestId exists at the API layer (the intent
 *                           creation request), but is not persisted on the
 *                           intent/decision/action record. A future enhancement
 *                           could persist it, but the current architecture
 *                           processes intents asynchronously via events.
 *   providerKey       ⛔  — intentionally absent: the connectivity control plane
 *                           uses its own provisioning-lease mechanism
 *                           (claimProvisioning, not runIdempotentOperation).
 *                           The providerKey is the idempotency primitive's
 *                           external correlation key — it applies to commerce
 *                           operations (createOrder, initiatePayment, purchaseTopUp),
 *                           not connectivity resource provisioning.
 *
 * Commerce operations (createOrder, initiatePayment, purchaseTopUp):
 *   providerKey       ✅  — from runIdempotentOperation
 *   requestId         ✅  — from the API route's getRequestId(req)
 *   tenantId          ✅  — from the principal context
 *   All control-plane fields (actionId, sessionId, etc.) — ⛔ intentionally
 *   absent: commerce operations are not connectivity control-plane actions.
 */

import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Correlation Context
// ---------------------------------------------------------------------------

export type ProviderCorrelationContext = {
  requestId?: string | null;
  tenantId?: string | null;
  providerInstanceId?: string | null;
  providerResourceId?: string | null;
  intentId?: string | null;
  decisionId?: string | null;
  actionId?: string | null;
  providerKey?: string | null;
  bindingId?: string | null;
  sessionId?: string | null;
};

export function createCorrelationContext(input: Partial<ProviderCorrelationContext>): ProviderCorrelationContext {
  return {
    requestId: input.requestId ?? null,
    tenantId: input.tenantId ?? null,
    providerInstanceId: input.providerInstanceId ?? null,
    providerResourceId: input.providerResourceId ?? null,
    intentId: input.intentId ?? null,
    decisionId: input.decisionId ?? null,
    actionId: input.actionId ?? null,
    providerKey: input.providerKey ?? null,
    bindingId: input.bindingId ?? null,
    sessionId: input.sessionId ?? null,
  };
}

/**
 * Merge correlation fields into a log entry object. Only non-null fields
 * are included — null/undefined fields are omitted to avoid noise.
 */
export function withCorrelation(
  ctx: ProviderCorrelationContext,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...fields };
  if (ctx.requestId) result.requestId = ctx.requestId;
  if (ctx.tenantId) result.tenantId = ctx.tenantId;
  if (ctx.providerInstanceId) result.providerInstanceId = ctx.providerInstanceId;
  if (ctx.providerResourceId) result.providerResourceId = ctx.providerResourceId;
  if (ctx.intentId) result.intentId = ctx.intentId;
  if (ctx.decisionId) result.decisionId = ctx.decisionId;
  if (ctx.actionId) result.actionId = ctx.actionId;
  if (ctx.providerKey) result.providerKey = ctx.providerKey;
  if (ctx.bindingId) result.bindingId = ctx.bindingId;
  if (ctx.sessionId) result.sessionId = ctx.sessionId;
  return result;
}

// ---------------------------------------------------------------------------
// Operational State Summary (for operator dashboards)
// ---------------------------------------------------------------------------

export type OperationalStateSummary = {
  generatedAt: Date;
  idempotencyOperations: {
    inProgress: number;
    completed: number;
    failed: number;
    reconciliationRequired: number;
    reconciliationClaimed: number;
  };
  sessions: {
    active: number;
    planned: number;
    switching: number;
    reconciliationRequired: number;
  };
  bindings: {
    bound: number;
    provisioning: number;
    degraded: number;
    failed: number;
    released: number;
  };
  pendingEvents: number;
  expiredSlots: number;
  expiredIdempotencyLeases: number;
};

/**
 * Generate an operational state summary for operator dashboards.
 * Queries the database for current state counts across the platform.
 */
export async function getOperationalStateSummary(): Promise<OperationalStateSummary> {
  const [
    inProgress, completed, failed, reconciliationRequired, reconciliationClaimed,
    activeSessions, plannedSessions, switchingSessions, reconciliationSessions,
    boundBindings, provisioningBindings, degradedBindings, failedBindings, releasedBindings,
    pendingEvents,
    expiredSlots,
    expiredIdempotencyLeases,
  ] = await Promise.all([
    db.idempotencyOperation.count({ where: { state: "IN_PROGRESS" } }),
    db.idempotencyOperation.count({ where: { state: "COMPLETED" } }),
    db.idempotencyOperation.count({ where: { state: "FAILED" } }),
    db.idempotencyOperation.count({ where: { state: "RECONCILIATION_REQUIRED" } }),
    db.idempotencyOperation.count({ where: { state: "RECONCILIATION_CLAIMED" } }),
    db.connectivitySession.count({ where: { state: "ACTIVE" } }),
    db.connectivitySession.count({ where: { state: "PLANNED" } }),
    db.connectivitySession.count({ where: { state: "SWITCHING" } }),
    db.connectivitySession.count({ where: { state: "RECONCILIATION_REQUIRED" } }),
    db.providerResourceBinding.count({ where: { status: "BOUND" } }),
    db.providerResourceBinding.count({ where: { status: "PROVISIONING" } }),
    db.providerResourceBinding.count({ where: { status: "DEGRADED" } }),
    db.providerResourceBinding.count({ where: { status: "FAILED" } }),
    db.providerResourceBinding.count({ where: { status: "RELEASED" } }),
    db.reevaluationEvent.count({ where: { state: "PENDING" } }),
    db.connectivitySession.count({
      where: { executionSlotClaimExpiresAt: { lt: new Date() }, executionSlotClaimId: { not: null } },
    }),
    db.idempotencyOperation.count({
      where: { state: "IN_PROGRESS", claimExpiresAt: { lt: new Date() } },
    }),
  ]);

  return {
    generatedAt: new Date(),
    idempotencyOperations: { inProgress, completed, failed, reconciliationRequired, reconciliationClaimed },
    sessions: { active: activeSessions, planned: plannedSessions, switching: switchingSessions, reconciliationRequired: reconciliationSessions },
    bindings: { bound: boundBindings, provisioning: provisioningBindings, degraded: degradedBindings, failed: failedBindings, released: releasedBindings },
    pendingEvents,
    expiredSlots,
    expiredIdempotencyLeases,
  };
}
