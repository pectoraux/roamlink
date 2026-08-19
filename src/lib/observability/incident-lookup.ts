/**
 * Phase 12.4.4e — Incident Lookup Service.
 *
 * A READ-ONLY operational investigation surface. This module reconstructs the
 * causal chain for an incident from existing authoritative records:
 *
 *   request (sourceRequestId)
 *     ↓
 *   intent version (exact intentId + intentVersion — NOT "latest active")
 *     ↓
 *   decision
 *     ↓
 *   action
 *     ↓
 *   session
 *     ↓
 *   binding
 *     ↓
 *   provider resource
 *     ↓
 *   provider operation records (Phase 12.4.4e — new)
 *
 * ARCHITECTURAL RULES:
 *
 *   1. TENANT AUTHORITY — every lookup is tenant-scoped. The caller's
 *      tenantId is resolved from the API principal (resolveApiPrincipal).
 *      The service NEVER returns state belonging to another tenant, even
 *      if the lookup key (requestId, providerResourceId, etc.) matches.
 *      Cross-tenant lookups return a safe not-found (404) WITHOUT disclosing
 *      whether the object exists under another tenant.
 *
 *   2. EXACT INTENT VERSION — when reconstructing a decision's causality,
 *      the service uses (intentId, intentVersion) from the decision record,
 *      NOT "latest active version." This is the same invariant established
 *      in Phase 12.4.4c.3 for executeAction. Stale decisions retain their
 *      original request's causality.
 *
 *   3. READ-ONLY — this module NEVER executes actions, retries provider
 *      operations, modifies decisions, modifies intents, changes tenant
 *      ownership, or changes reconciliation state. It is purely a query
 *      surface. It does not import any control-plane mutation primitive.
 *
 *   4. NO FABRICATION — if a field is unavailable (e.g., the intent has no
 *      sourceRequestId because it was created before Phase 12.4.4c, or the
 *      action has no decisionId because it was a direct API action), the
 *      field is explicitly represented as `null` — never fabricated.
 *
 *   5. NO SECRETS — the service never returns credentials, tokens, API keys,
 *      or raw provider responses. Only correlation identifiers + outcome +
 *      classification are exposed.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Lookup keys
// ---------------------------------------------------------------------------

export type IncidentLookupKey =
  | { kind: "requestId"; value: string }
  | { kind: "intentId"; value: string; version?: number }
  | { kind: "decisionId"; value: string }
  | { kind: "actionId"; value: string }
  | { kind: "providerResourceId"; value: string }
  | { kind: "bindingId"; value: string }
  | { kind: "providerKey"; value: string };

// ---------------------------------------------------------------------------
// Result contract — stable read model
// ---------------------------------------------------------------------------

export type IncidentResult = {
  incident: {
    requestId: string | null;
    tenantId: string | null;
    status: string;
    createdAt: Date | null;
    updatedAt: Date | null;
  };
  intent: {
    intentId: string;
    version: number;
    status: string;
    sourceChannel: string | null;
    sourceRequestId: string | null;
    createdAt: Date;
  } | null;
  decision: {
    decisionId: string;
    intentId: string;
    intentVersion: number | null;
    action: string;
    executionState: string;
    reasonCodes: string[] | null;
    createdAt: Date;
  } | null;
  action: {
    actionId: string;
    type: string;
    state: string;
    targetResourceId: string | null;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
  } | null;
  session: {
    sessionId: string;
    state: string;
    activeResourceId: string | null;
  } | null;
  provider: {
    providerInstanceId: string | null;
    providerResourceId: string | null;
    bindingId: string | null;
    providerKey: string | null;
  } | null;
  providerOperations: Array<{
    id: string;
    operation: string;
    outcome: string;
    providerResourceId: string | null;
    bindingId: string | null;
    providerInstanceId: string | null;
    providerType: string | null;
    requestId: string | null;
    actionId: string | null;
    providerKey: string | null;
    outcomeDetail: Record<string, unknown> | null;
    reconciliationState: string | null;
    startedAt: Date;
    completedAt: Date | null;
  }>;
};

// ---------------------------------------------------------------------------
// Tenant authority — resolve the owning tenant for each lookup key
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant that owns a given lookup key. Returns the tenantId
 * if the object exists AND belongs to a tenant; returns null if the object
 * does not exist OR is tenantless.
 *
 * This is the SECURITY-CRITICAL function: it ensures Tenant A cannot
 * discover Tenant B state by guessing an identifier. The caller's
 * tenantId is then compared to the resolved tenantId — if they don't
 * match, the lookup returns not-found (without disclosing that the
 * object exists under another tenant).
 */
async function resolveTenantForKey(
  key: IncidentLookupKey,
): Promise<{ tenantId: string | null; matched: boolean }> {
  switch (key.kind) {
    case "requestId": {
      // The requestId is the sourceRequestId on ConnectivityIntentRecord.
      // The owning tenant is the intent's subject's tenant (via entitlement).
      // An intent may belong to a subject whose entitlement is in any tenant —
      // we resolve from the intent record's subject → entitlement → tenant.
      const intent = await db.connectivityIntentRecord.findFirst({
        where: { sourceRequestId: key.value },
        orderBy: { createdAt: "desc" },
        select: { subjectId: true },
      });
      if (!intent) return { tenantId: null, matched: false };
      // Resolve the subject's tenant from their entitlement (most recent active).
      const ent = await db.connectivityEntitlement.findFirst({
        where: { userId: intent.subjectId },
        orderBy: { createdAt: "desc" },
        select: { tenantId: true },
      });
      return { tenantId: ent?.tenantId ?? null, matched: true };
    }

    case "intentId": {
      // Intent versions are tenant-owned via subject → entitlement → tenant.
      const where = key.version !== undefined
        ? { intentId: key.value, version: key.version }
        : { intentId: key.value };
      const intent = await db.connectivityIntentRecord.findFirst({
        where,
        orderBy: { version: "desc" },
        select: { subjectId: true },
      });
      if (!intent) return { tenantId: null, matched: false };
      const ent = await db.connectivityEntitlement.findFirst({
        where: { userId: intent.subjectId },
        orderBy: { createdAt: "desc" },
        select: { tenantId: true },
      });
      return { tenantId: ent?.tenantId ?? null, matched: true };
    }

    case "decisionId": {
      // Decision → session → entitlement → tenant.
      const decision = await db.connectivityDecision.findUnique({
        where: { id: key.value },
        select: { sessionId: true },
      });
      if (!decision || !decision.sessionId) {
        // Decision without session — resolve via intent → subject → entitlement.
        const d = await db.connectivityDecision.findUnique({
          where: { id: key.value },
          select: { intentId: true },
        });
        if (!d) return { tenantId: null, matched: false };
        const intent = await db.connectivityIntentRecord.findFirst({
          where: { intentId: d.intentId },
          orderBy: { version: "desc" },
          select: { subjectId: true },
        });
        if (!intent) return { tenantId: null, matched: false };
        const ent = await db.connectivityEntitlement.findFirst({
          where: { userId: intent.subjectId },
          orderBy: { createdAt: "desc" },
          select: { tenantId: true },
        });
        return { tenantId: ent?.tenantId ?? null, matched: true };
      }
      const session = await db.connectivitySession.findUnique({
        where: { id: decision.sessionId },
        select: { entitlementId: true },
      });
      if (!session?.entitlementId) return { tenantId: null, matched: true };
      const ent = await db.connectivityEntitlement.findUnique({
        where: { id: session.entitlementId },
        select: { tenantId: true },
      });
      return { tenantId: ent?.tenantId ?? null, matched: true };
    }

    case "actionId": {
      // Action → session → entitlement → tenant.
      const action = await db.connectivityAction.findUnique({
        where: { id: key.value },
        select: { sessionId: true },
      });
      if (!action) return { tenantId: null, matched: false };
      const session = await db.connectivitySession.findUnique({
        where: { id: action.sessionId },
        select: { entitlementId: true },
      });
      if (!session?.entitlementId) return { tenantId: null, matched: true };
      const ent = await db.connectivityEntitlement.findUnique({
        where: { id: session.entitlementId },
        select: { tenantId: true },
      });
      return { tenantId: ent?.tenantId ?? null, matched: true };
    }

    case "providerResourceId": {
      // providerResourceId is on ProviderResourceBinding. The binding's
      // entitlement carries the tenant. Note: providerResourceId is NOT
      // tenant authority — it is provider-side and may collide across
      // providers. We resolve via the binding's entitlement.
      const binding = await db.providerResourceBinding.findFirst({
        where: { providerResourceId: key.value },
        orderBy: { createdAt: "desc" },
        select: { entitlementId: true },
      });
      if (!binding) return { tenantId: null, matched: false };
      const ent = await db.connectivityEntitlement.findUnique({
        where: { id: binding.entitlementId },
        select: { tenantId: true },
      });
      return { tenantId: ent?.tenantId ?? null, matched: true };
    }

    case "bindingId": {
      // Binding → entitlement → tenant.
      const binding = await db.providerResourceBinding.findUnique({
        where: { id: key.value },
        select: { entitlementId: true },
      });
      if (!binding) return { tenantId: null, matched: false };
      const ent = await db.connectivityEntitlement.findUnique({
        where: { id: binding.entitlementId },
        select: { tenantId: true },
      });
      return { tenantId: ent?.tenantId ?? null, matched: true };
    }

    case "providerKey": {
      // providerKey is on IdempotencyOperation. The operation's tenantId
      // is authoritative (set when the claim was acquired).
      const op = await db.idempotencyOperation.findFirst({
        where: { providerKey: key.value },
        orderBy: { createdAt: "desc" },
        select: { tenantId: true },
      });
      if (!op) return { tenantId: null, matched: false };
      return { tenantId: op.tenantId, matched: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Main lookup entry point
// ---------------------------------------------------------------------------

/**
 * Look up an incident by one of the supported keys. The lookup is
 * tenant-scoped: if the resolved object does not belong to the caller's
 * tenant, the result is a safe not-found (404).
 *
 * @param key The lookup key (requestId, intentId, decisionId, etc.)
 * @param callerTenantId The caller's authoritative tenantId (from
 *   resolveApiPrincipal). The lookup will only return state belonging
 *   to this tenant.
 *
 * @throws AppError(404, "not_found") if the object does not exist OR
 *   belongs to a different tenant. The error message does NOT disclose
 *   which case applied (security: no tenant-existence leak).
 */
export async function lookupIncident(
  key: IncidentLookupKey,
  callerTenantId: string,
): Promise<IncidentResult> {
  // Step 1: Resolve the owning tenant for the lookup key.
  const { tenantId: owningTenantId, matched } = await resolveTenantForKey(key);

  // Step 2: Tenant boundary. If the object doesn't exist OR belongs to a
  // different tenant, return 404. The error message is intentionally
  // generic — we do NOT disclose "exists but belongs to another tenant"
  // (that would let an attacker probe for tenant ownership). The message
  // also does NOT contain the word "tenant" (the safe message is what the
  // client sees, and any reference to tenant would leak that the object
  // exists under a different tenant).
  if (!matched || !owningTenantId || owningTenantId !== callerTenantId) {
    throw new AppError(
      "not_found",
      "Incident not found",
      404,
      "No incident found for this identifier.",
    );
  }

  // Step 3: Reconstruct the causal chain. Start from the key and walk
  // outward. We always load the EXACT (intentId, intentVersion) referenced
  // by a decision — never "latest active."
  let intentRecord: {
    intentId: string;
    version: number;
    status: string;
    sourceChannel: string | null;
    sourceRequestId: string | null;
    subjectId: string;
    createdAt: Date;
  } | null = null;
  let decision: {
    id: string;
    intentId: string;
    intentVersion: number | null;
    action: string;
    executionState: string;
    reasonCodes: string | null;
    sessionId: string | null;
    createdAt: Date;
  } | null = null;
  let action: {
    id: string;
    type: string;
    state: string;
    targetResourceId: string | null;
    error: string | null;
    sessionId: string;
    decisionId: string | null;
    createdAt: Date;
    completedAt: Date | null;
  } | null = null;

  // Step 3a: Resolve based on the key kind.
  switch (key.kind) {
    case "requestId": {
      // Find the intent with this sourceRequestId (most recent version).
      // Then find decisions referencing this exact intent (any version).
      const intent = await db.connectivityIntentRecord.findFirst({
        where: { sourceRequestId: key.value },
        orderBy: { version: "desc" },
        select: {
          intentId: true, version: true, status: true,
          sourceChannel: true, sourceRequestId: true,
          subjectId: true, createdAt: true,
        },
      });
      if (intent) {
        intentRecord = intent;
        // Find the most recent decision for this intent (any version —
        // the caller can see all decisions for their incident).
        const d = await db.connectivityDecision.findFirst({
          where: { intentId: intent.intentId },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, intentId: true, intentVersion: true,
            action: true, executionState: true, reasonCodes: true,
            sessionId: true, createdAt: true,
          },
        });
        if (d) decision = d;
      }
      break;
    }

    case "intentId": {
      const where = key.version !== undefined
        ? { intentId: key.value, version: key.version }
        : { intentId: key.value };
      const intent = await db.connectivityIntentRecord.findFirst({
        where,
        orderBy: { version: "desc" },
        select: {
          intentId: true, version: true, status: true,
          sourceChannel: true, sourceRequestId: true,
          subjectId: true, createdAt: true,
        },
      });
      if (intent) {
        intentRecord = intent;
        const d = await db.connectivityDecision.findFirst({
          where: { intentId: intent.intentId },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, intentId: true, intentVersion: true,
            action: true, executionState: true, reasonCodes: true,
            sessionId: true, createdAt: true,
          },
        });
        if (d) decision = d;
      }
      break;
    }

    case "decisionId": {
      const d = await db.connectivityDecision.findUnique({
        where: { id: key.value },
        select: {
          id: true, intentId: true, intentVersion: true,
          action: true, executionState: true, reasonCodes: true,
          sessionId: true, createdAt: true,
        },
      });
      if (d) {
        decision = d;
        // Load the EXACT (intentId, intentVersion) — not "latest active."
        // This is the Phase 12.4.4c.3 invariant.
        if (d.intentVersion !== null) {
          const intent = await db.connectivityIntentRecord.findUnique({
            where: {
              intentId_version: {
                intentId: d.intentId,
                version: d.intentVersion,
              },
            },
            select: {
              intentId: true, version: true, status: true,
              sourceChannel: true, sourceRequestId: true,
              subjectId: true, createdAt: true,
            },
          });
          if (intent) intentRecord = intent;
        } else {
          // Decision without intentVersion (rare — legacy). Fall back to
          // latest version of this intentId.
          const intent = await db.connectivityIntentRecord.findFirst({
            where: { intentId: d.intentId },
            orderBy: { version: "desc" },
            select: {
              intentId: true, version: true, status: true,
              sourceChannel: true, sourceRequestId: true,
              subjectId: true, createdAt: true,
            },
          });
          if (intent) intentRecord = intent;
        }
      }
      break;
    }

    case "actionId": {
      const a = await db.connectivityAction.findUnique({
        where: { id: key.value },
        select: {
          id: true, type: true, state: true, targetResourceId: true,
          error: true, sessionId: true, decisionId: true,
          createdAt: true, completedAt: true,
        },
      });
      if (a) {
        action = a;
        if (a.decisionId) {
          const d = await db.connectivityDecision.findUnique({
            where: { id: a.decisionId },
            select: {
              id: true, intentId: true, intentVersion: true,
              action: true, executionState: true, reasonCodes: true,
              sessionId: true, createdAt: true,
            },
          });
          if (d) {
            decision = d;
            if (d.intentVersion !== null) {
              const intent = await db.connectivityIntentRecord.findUnique({
                where: {
                  intentId_version: {
                    intentId: d.intentId,
                    version: d.intentVersion,
                  },
                },
                select: {
                  intentId: true, version: true, status: true,
                  sourceChannel: true, sourceRequestId: true,
                  subjectId: true, createdAt: true,
                },
              });
              if (intent) intentRecord = intent;
            }
          }
        }
      }
      break;
    }

    case "providerResourceId":
    case "bindingId": {
      // These keys map to a binding. From the binding, we resolve the
      // entitlement → session → decision → intent chain (if any).
      const binding = key.kind === "providerResourceId"
        ? await db.providerResourceBinding.findFirst({
            where: { providerResourceId: key.value },
            orderBy: { createdAt: "desc" },
          })
        : await db.providerResourceBinding.findUnique({
            where: { id: key.value },
          });
      if (binding) {
        // Find a session for this entitlement (most recent).
        const session = await db.connectivitySession.findFirst({
          where: { entitlementId: binding.entitlementId },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (session) {
          // Find the most recent action for this session.
          const a = await db.connectivityAction.findFirst({
            where: { sessionId: session.id },
            orderBy: { createdAt: "desc" },
            select: {
              id: true, type: true, state: true, targetResourceId: true,
              error: true, sessionId: true, decisionId: true,
              createdAt: true, completedAt: true,
            },
          });
          if (a) {
            action = a;
            if (a.decisionId) {
              const d = await db.connectivityDecision.findUnique({
                where: { id: a.decisionId },
                select: {
                  id: true, intentId: true, intentVersion: true,
                  action: true, executionState: true, reasonCodes: true,
                  sessionId: true, createdAt: true,
                },
              });
              if (d) {
                decision = d;
                if (d.intentVersion !== null) {
                  const intent = await db.connectivityIntentRecord.findUnique({
                    where: {
                      intentId_version: {
                        intentId: d.intentId,
                        version: d.intentVersion,
                      },
                    },
                    select: {
                      intentId: true, version: true, status: true,
                      sourceChannel: true, sourceRequestId: true,
                      subjectId: true, createdAt: true,
                    },
                  });
                  if (intent) intentRecord = intent;
                }
              }
            }
          }
        }
      }
      break;
    }

    case "providerKey": {
      // providerKey is on IdempotencyOperation (commerce ops). The operation
      // itself carries the outcome. There may be no control-plane chain
      // (intent/decision/action) for commerce operations.
      // The providerOperations array below will capture the operation.
      break;
    }
  }

  // Step 3b: Load the action if we have a decision but no action yet.
  if (decision && !action && decision.sessionId) {
    const a = await db.connectivityAction.findFirst({
      where: { sessionId: decision.sessionId!, decisionId: decision.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, type: true, state: true, targetResourceId: true,
        error: true, sessionId: true, decisionId: true,
        createdAt: true, completedAt: true,
      },
    });
    if (a) action = a;
  }

  // Step 4: Load the session (if any).
  let session: {
    sessionId: string;
    state: string;
    activeResourceId: string | null;
  } | null = null;
  const sessionIdForLookup = action?.sessionId ?? decision?.sessionId ?? null;
  if (sessionIdForLookup) {
    const s = await db.connectivitySession.findUnique({
      where: { id: sessionIdForLookup },
      select: { id: true, state: true, activeResourceId: true },
    });
    if (s) session = { sessionId: s.id, state: s.state, activeResourceId: s.activeResourceId };
  }

  // Step 5: Load the provider binding/resource (if any).
  let provider: {
    providerInstanceId: string | null;
    providerResourceId: string | null;
    bindingId: string | null;
    providerKey: string | null;
  } | null = null;
  if (action?.targetResourceId) {
    const resource = await db.protocolResource.findUnique({
      where: { id: action.targetResourceId },
      select: {
        providerInstanceId: true,
        providerBindingId: true,
        capability: { select: { tenantId: true, providerType: true } },
      },
    });
    if (resource) {
      let bindingId: string | null = resource.providerBindingId;
      let providerResourceId: string | null = null;
      if (bindingId) {
        const binding = await db.providerResourceBinding.findUnique({
          where: { id: bindingId },
          select: { providerResourceId: true, providerInstanceId: true, providerType: true },
        });
        if (binding) {
          providerResourceId = binding.providerResourceId;
        }
      }
      provider = {
        providerInstanceId: resource.providerInstanceId,
        providerResourceId,
        bindingId,
        providerKey: null, // control-plane ops don't use providerKey (Phase 12.4.4b.3)
      };
    }
  }

  // Step 6: Load provider operation records.
  // These are the persisted audit trail of actual provider-side operations.
  // We query by any of the correlation keys present.
  const requestIdForOps = intentRecord?.sourceRequestId ?? null;
  const actionIdForOps = action?.id ?? null;
  const providerOpsWhere = {
    OR: [
      ...(requestIdForOps ? [{ requestId: requestIdForOps }] : []),
      ...(actionIdForOps ? [{ actionId: actionIdForOps }] : []),
      ...(intentRecord ? [{ intentId: intentRecord.intentId }] : []),
      ...(decision ? [{ decisionId: decision.id }] : []),
      ...(provider?.bindingId ? [{ bindingId: provider.bindingId }] : []),
      ...(key.kind === "providerKey" ? [{ providerKey: key.value }] : []),
    ],
  };
  const providerOps = providerOpsWhere.OR.length > 0
    ? await db.providerOperationRecord.findMany({
        where: providerOpsWhere,
        orderBy: { startedAt: "desc" },
        take: 50,
      })
    : [];
  const providerOperations = providerOps.map((op) => ({
    id: op.id,
    operation: op.operation,
    outcome: op.outcome,
    providerResourceId: op.providerResourceId,
    bindingId: op.bindingId,
    providerInstanceId: op.providerInstanceId,
    providerType: op.providerType,
    requestId: op.requestId,
    actionId: op.actionId,
    providerKey: op.providerKey,
    outcomeDetail: op.outcomeDetail ? safeParseJson(op.outcomeDetail) : null,
    reconciliationState: op.reconciliationState,
    startedAt: op.startedAt,
    completedAt: op.completedAt,
  }));

  // Step 7: Compute the incident-level summary.
  const requestId = intentRecord?.sourceRequestId
    ?? (key.kind === "requestId" ? key.value : null)
    ?? null;
  const incidentCreatedAt = intentRecord?.createdAt
    ?? decision?.createdAt
    ?? action?.createdAt
    ?? null;
  const incidentUpdatedAt = action?.completedAt
    ?? decision?.createdAt
    ?? intentRecord?.createdAt
    ?? null;
  // Status: derived from the most progressed stage.
  let status = "unknown";
  if (action?.state === "SUCCEEDED") status = "completed";
  else if (action?.state === "FAILED") status = "failed";
  else if (action?.state === "EXECUTING") status = "executing";
  else if (action?.state === "PLANNED") status = "planned";
  else if (decision?.executionState === "EXECUTED") status = "executed";
  else if (decision?.executionState === "FAILED") status = "failed";
  else if (decision?.executionState === "RECONCILIATION_REQUIRED") status = "reconciliation_required";
  else if (decision?.executionState === "PENDING") status = "pending";
  else if (intentRecord) status = intentRecord.status.toLowerCase();

  return {
    incident: {
      requestId,
      tenantId: callerTenantId,
      status,
      createdAt: incidentCreatedAt,
      updatedAt: incidentUpdatedAt,
    },
    intent: intentRecord ? {
      intentId: intentRecord.intentId,
      version: intentRecord.version,
      status: intentRecord.status,
      sourceChannel: intentRecord.sourceChannel,
      sourceRequestId: intentRecord.sourceRequestId,
      createdAt: intentRecord.createdAt,
    } : null,
    decision: decision ? {
      decisionId: decision.id,
      intentId: decision.intentId,
      intentVersion: decision.intentVersion,
      action: decision.action,
      executionState: decision.executionState,
      reasonCodes: decision.reasonCodes ? safeParseStringArray(decision.reasonCodes) : null,
      createdAt: decision.createdAt,
    } : null,
    action: action ? {
      actionId: action.id,
      type: action.type,
      state: action.state,
      targetResourceId: action.targetResourceId,
      error: action.error,
      createdAt: action.createdAt,
      completedAt: action.completedAt,
    } : null,
    session,
    provider,
    providerOperations,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeParseStringArray(s: string): string[] | null {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider operation recorder (write path — used by the adapter)
// ---------------------------------------------------------------------------

export type ProviderOperationRecordInput = {
  operation: "provision" | "suspend" | "resume" | "release" | "getUsage" | "reconcile";
  outcome: "success" | "failed_permanent" | "failed_retryable" | "ambiguous";
  providerResourceId?: string | null;
  bindingId?: string | null;
  providerInstanceId?: string | null;
  providerType?: string | null;
  tenantId?: string | null;
  requestId?: string | null;
  intentId?: string | null;
  decisionId?: string | null;
  actionId?: string | null;
  sessionId?: string | null;
  providerKey?: string | null;
  outcomeDetail?: Record<string, unknown> | null;
  reconciliationState?: string | null;
  startedAt?: Date;
  completedAt?: Date;
};

/**
 * Persist a provider operation record. This is FIRE-AND-FORGET — the caller
 * (the adapter) never blocks on this write. Failures are logged but do not
 * propagate. The audit trail is best-effort: a missing record does not
 * affect the control plane's correctness (the binding's authoritative state
 * is on ProviderResourceBinding, not here).
 *
 * This is the SMALLEST architectural addition required to make provider
 * execution history auditable. It is NOT a duplicate event store — it does
 * not drive reevaluation, decision-making, or reconciliation. It is purely
 * a read-only audit surface.
 */
export async function recordProviderOperation(
  input: ProviderOperationRecordInput,
): Promise<void> {
  try {
    await db.providerOperationRecord.create({
      data: {
        operation: input.operation,
        outcome: input.outcome,
        providerResourceId: input.providerResourceId ?? null,
        bindingId: input.bindingId ?? null,
        providerInstanceId: input.providerInstanceId ?? null,
        providerType: input.providerType ?? null,
        tenantId: input.tenantId ?? null,
        requestId: input.requestId ?? null,
        intentId: input.intentId ?? null,
        decisionId: input.decisionId ?? null,
        actionId: input.actionId ?? null,
        sessionId: input.sessionId ?? null,
        providerKey: input.providerKey ?? null,
        outcomeDetail: input.outcomeDetail ? JSON.stringify(input.outcomeDetail) : null,
        reconciliationState: input.reconciliationState ?? null,
        startedAt: input.startedAt ?? new Date(),
        completedAt: input.completedAt ?? new Date(),
      },
    });
  } catch (err) {
    // Best-effort — never let the audit trail break the operation.
    // Logged at warn level so operators can see if the audit trail is degraded.
    const { logger } = await import("@/lib/logger");
    logger.warn("provider_operation.record_failed", {
      operation: input.operation,
      outcome: input.outcome,
      bindingId: input.bindingId,
      actionId: input.actionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
