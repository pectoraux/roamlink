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
    state: string;
    outcome: string | null;
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
    // Phase 12.4.4f: Recovery metadata for STARTED records.
    recoveryClaimId: string | null;
    recoveryClaimedAt: Date | null;
    recoveryClaimExpiresAt: Date | null;
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
 * Phase 12.4.4e (P0-1) — EXACT AUTHORITATIVE RELATIONSHIPS:
 *
 * This function NEVER uses "latest entitlement for user" to resolve tenant
 * ownership. That shortcut was unsafe for users belonging to multiple tenants
 * (Tenant B's newer entitlement would shadow Tenant A's incident).
 *
 * Instead, each key resolves through its EXACT authoritative relationship:
 *
 *   requestId     → ConnectivityIntentRecord.sourceRequestId
 *                   → intent.tenantId (Phase 12.4.4e P0-1 field, authoritative)
 *                   Fallback (legacy records without tenantId):
 *                     → decision for this intent → session → entitlement → tenantId
 *                     (NOT "latest entitlement for user")
 *
 *   intentId      → ConnectivityIntentRecord.tenantId (authoritative)
 *                   Same fallback as requestId for legacy records.
 *
 *   decisionId    → decision.sessionId → session.entitlementId → entitlement.tenantId
 *                   (EXACT session, not "latest entitlement for user")
 *                   Fallback (decision without session):
 *                     → decision.intentId → intent.tenantId (authoritative)
 *
 *   actionId      → action.sessionId → session.entitlementId → entitlement.tenantId
 *                   (EXACT session)
 *
 *   providerResourceId → ProviderResourceBinding.entitlementId → entitlement.tenantId
 *                        (EXACT binding, not "latest")
 *
 *   bindingId     → ProviderResourceBinding.entitlementId → entitlement.tenantId
 *                   (EXACT binding)
 *
 *   providerKey   → IdempotencyOperation.tenantId (authoritative, set at claim time)
 *
 * This is the SECURITY-CRITICAL function: it ensures Tenant A cannot
 * discover Tenant B state by guessing an identifier. The caller's
 * tenantId is then compared to the resolved tenantId — if they don't
 * match, the lookup returns not-found (without disclosing that the
 * object exists under another tenant).
 */
async function resolveTenantForKey(
  key: IncidentLookupKey,
  callerTenantId: string,
): Promise<{ tenantId: string | null; matched: boolean }> {
  switch (key.kind) {
    case "requestId": {
      // Phase 12.4.4e (P0-1): Resolve via the EXACT intent record carrying
      // this sourceRequestId — use intent.tenantId (authoritative).
      const intent = await db.connectivityIntentRecord.findFirst({
        where: { sourceRequestId: key.value },
        orderBy: { version: "desc" },
        select: { tenantId: true, intentId: true, subjectId: true },
      });
      if (!intent) return { tenantId: null, matched: false };
      // If the intent has an authoritative tenantId, use it.
      if (intent.tenantId) return { tenantId: intent.tenantId, matched: true };
      // Legacy fallback: resolve via decision → session → entitlement (exact).
      // This is NOT "latest entitlement for user" — it's the EXACT session
      // that the decision was made for.
      const tenantFromChain = await resolveTenantViaDecisionChain(intent.intentId);
      return { tenantId: tenantFromChain, matched: true };
    }

    case "intentId": {
      // Phase 12.4.4e (P0-1): Resolve via the EXACT intent version — use
      // intent.tenantId (authoritative).
      const where = key.version !== undefined
        ? { intentId: key.value, version: key.version }
        : { intentId: key.value };
      const intent = await db.connectivityIntentRecord.findFirst({
        where,
        orderBy: { version: "desc" },
        select: { tenantId: true, intentId: true },
      });
      if (!intent) return { tenantId: null, matched: false };
      if (intent.tenantId) return { tenantId: intent.tenantId, matched: true };
      // Legacy fallback: resolve via decision → session → entitlement (exact).
      const tenantFromChain = await resolveTenantViaDecisionChain(intent.intentId);
      return { tenantId: tenantFromChain, matched: true };
    }

    case "decisionId": {
      // Phase 12.4.4e (P0-1): decision → session → entitlement → tenant (EXACT).
      const decision = await db.connectivityDecision.findUnique({
        where: { id: key.value },
        select: { sessionId: true, intentId: true, intentVersion: true },
      });
      if (!decision) return { tenantId: null, matched: false };
      // Primary path: decision → session → entitlement → tenant (exact).
      if (decision.sessionId) {
        const session = await db.connectivitySession.findUnique({
          where: { id: decision.sessionId },
          select: { entitlementId: true },
        });
        if (session?.entitlementId) {
          const ent = await db.connectivityEntitlement.findUnique({
            where: { id: session.entitlementId },
            select: { tenantId: true },
          });
          if (ent?.tenantId) return { tenantId: ent.tenantId, matched: true };
        }
      }
      // Fallback: decision → intent.tenantId (authoritative, Phase 12.4.4e).
      if (decision.intentId) {
        // Use the EXACT intent version from the decision (Phase 12.4.4c.3 invariant).
        if (decision.intentVersion != null) {
          const intent = await db.connectivityIntentRecord.findUnique({
            where: { intentId_version: { intentId: decision.intentId, version: decision.intentVersion } },
            select: { tenantId: true },
          });
          if (intent?.tenantId) return { tenantId: intent.tenantId, matched: true };
        } else {
          const intent = await db.connectivityIntentRecord.findFirst({
            where: { intentId: decision.intentId },
            orderBy: { version: "desc" },
            select: { tenantId: true },
          });
          if (intent?.tenantId) return { tenantId: intent.tenantId, matched: true };
        }
        // Final fallback: resolve via the decision chain (exact session/entitlement).
        const tenantFromChain = await resolveTenantViaDecisionChain(decision.intentId);
        return { tenantId: tenantFromChain, matched: true };
      }
      return { tenantId: null, matched: true };
    }

    case "actionId": {
      // action → session → entitlement → tenant (EXACT).
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
      // Phase 12.4.4e (P0-1, 12.4.4e.11): providerResourceId can be SHARED
      // across tenants (two bindings in different tenants can have the same
      // providerResourceId — e.g., the provider reuses a username). We must
      // resolve via the EXACT binding that belongs to the CALLER's tenant.
      //
      // We query for bindings with this providerResourceId WHERE the binding's
      // entitlement belongs to the caller's tenant. If found, return the
      // caller's tenantId. If not found, return null (not found — safe 404).
      const binding = await db.providerResourceBinding.findFirst({
        where: {
          providerResourceId: key.value,
          entitlement: { tenantId: callerTenantId },
        },
        orderBy: { createdAt: "desc" },
        select: { entitlementId: true },
      });
      if (!binding) return { tenantId: null, matched: false };
      // The binding belongs to the caller's tenant — return callerTenantId.
      return { tenantId: callerTenantId, matched: true };
    }

    case "bindingId": {
      // binding → entitlement → tenant (EXACT).
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
      // providerKey → IdempotencyOperation.tenantId (authoritative).
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

/**
 * Legacy fallback: resolve tenant via the EXACT decision → session → entitlement
 * chain for a given intentId. This is used for intent records created before
 * Phase 12.4.4e (which don't have a tenantId field).
 *
 * This is NOT "latest entitlement for user" — it walks the EXACT decision and
 * session that were created for this intent. If no decision exists yet, the
 * tenant cannot be resolved authoritatively (returns null → 404).
 */
async function resolveTenantViaDecisionChain(intentId: string): Promise<string | null> {
  // Find the most recent decision for this exact intentId.
  const decision = await db.connectivityDecision.findFirst({
    where: { intentId },
    orderBy: { createdAt: "desc" },
    select: { sessionId: true },
  });
  if (!decision?.sessionId) return null;
  const session = await db.connectivitySession.findUnique({
    where: { id: decision.sessionId },
    select: { entitlementId: true },
  });
  if (!session?.entitlementId) return null;
  const ent = await db.connectivityEntitlement.findUnique({
    where: { id: session.entitlementId },
    select: { tenantId: true },
  });
  return ent?.tenantId ?? null;
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
  const { tenantId: owningTenantId, matched } = await resolveTenantForKey(key, callerTenantId);

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
      // Phase 12.4.4e.11: For providerResourceId, filter by the caller's
      // tenant via the entitlement relation — providerResourceId can be
      // shared across tenants.
      const binding = key.kind === "providerResourceId"
        ? await db.providerResourceBinding.findFirst({
            where: {
              providerResourceId: key.value,
              entitlement: { tenantId: callerTenantId },
            },
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
    state: op.state,
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
    recoveryClaimId: op.recoveryClaimId,
    recoveryClaimedAt: op.recoveryClaimedAt,
    recoveryClaimExpiresAt: op.recoveryClaimExpiresAt,
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
// Provider operation lifecycle (Phase 12.4.4e P0-2 — durable audit)
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a provider operation record.
 *
 *   STARTED           — record created BEFORE the provider mutation. The
 *                       operation is in progress (or the process crashed
 *                       before the terminal update).
 *   SUCCEEDED         — provider mutation succeeded. Terminal.
 *   FAILED_PERMANENT  — provider returned a permanent failure. Terminal.
 *   FAILED_RETRYABLE  — provider returned a transient failure. Terminal.
 *   AMBIGUOUS         — provider outcome is unknown. Terminal. Requires reconciliation.
 *   RECONCILIATION_REQUIRED — adapter explicitly classified this as requiring
 *                       reconciliation. Terminal.
 */
export type ProviderOperationState =
  | "STARTED"
  | "SUCCEEDED"
  | "FAILED_PERMANENT"
  | "FAILED_RETRYABLE"
  | "AMBIGUOUS"
  | "RECONCILIATION_REQUIRED";

export type ProviderOperationRecordInput = {
  operation: "provision" | "suspend" | "resume" | "release" | "getUsage" | "reconcile";
  providerResourceId?: string | null;
  bindingId?: string | null;
  providerInstanceId?: string | null;
  providerType?: string | null;
  tenantId: string; // REQUIRED (Phase 12.4.4e P0-3)
  requestId?: string | null;
  intentId?: string | null;
  decisionId?: string | null;
  actionId?: string | null;
  sessionId?: string | null;
  providerKey?: string | null;
  reconciliationState?: string | null;
};

/**
 * Phase 12.4.4e (P0-2) + Phase 12.4.4e.2 (durable identity BEFORE mutation):
 * Create a durable STARTED record BEFORE the provider mutation.
 *
 * HARD INVARIANT:
 *   provider mutation starts ⇒ durable ProviderOperationRecord already exists.
 *
 *   This function MUST either return a non-null recordId OR throw.
 *   It MUST NOT silently return null and permit the provider call.
 *
 * On success: returns the record ID.
 * On DB failure: throws AuditStartFailureError. The provider mutation MUST NOT
 *   begin. The caller (adapter) catches this and returns a control-plane
 *   infrastructure error — NOT a provider failure. No external side effect
 *   has occurred.
 *
 * WHY THIS IS DIFFERENT FROM TERMINAL-WRITE FAILURE (Phase 12.4.4e.1):
 *   - START failure: the provider has NOT been called yet. No external side
 *     effect exists. The correct behavior is to FAIL CLOSED — abort the
 *     operation before the provider is touched.
 *   - Terminal failure: the provider mutation ALREADY happened. The result
 *     is authoritative. The audit record stays STARTED and is recoverable.
 *
 * These are fundamentally different failure classes and MUST NOT be conflated.
 */
export async function startProviderOperation(
  input: ProviderOperationRecordInput,
): Promise<string> {
  try {
    const record = await db.providerOperationRecord.create({
      data: {
        operation: input.operation,
        state: "STARTED",
        providerResourceId: input.providerResourceId ?? null,
        bindingId: input.bindingId ?? null,
        providerInstanceId: input.providerInstanceId ?? null,
        providerType: input.providerType ?? null,
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        intentId: input.intentId ?? null,
        decisionId: input.decisionId ?? null,
        actionId: input.actionId ?? null,
        sessionId: input.sessionId ?? null,
        providerKey: input.providerKey ?? null,
        reconciliationState: input.reconciliationState ?? null,
        startedAt: new Date(),
      },
    });
    return record.id;
  } catch (err) {
    // Phase 12.4.4e.2: FAIL CLOSED. The provider mutation MUST NOT begin.
    // Log the audit-start failure with full correlation context (no secrets).
    const { logger } = await import("@/lib/logger");
    logger.error("provider_operation.start_failed_closed", {
      operation: input.operation,
      tenantId: input.tenantId,
      providerInstanceId: input.providerInstanceId,
      providerResourceId: input.providerResourceId,
      bindingId: input.bindingId,
      actionId: input.actionId,
      requestId: input.requestId,
      intentId: input.intentId,
      decisionId: input.decisionId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
      reason: "STARTED insert failed; provider mutation prohibited (fail closed)",
    });
    throw new AuditStartFailureError(
      `Failed to establish durable audit identity for ${input.operation}: ${err instanceof Error ? err.message : String(err)}`,
      input.operation,
    );
  }
}

/**
 * Phase 12.4.4e.2: Typed error for audit-start failure.
 *
 * This is a LOCAL INFRASTRUCTURE failure — RoamLink could not durably
 * establish operation identity, therefore no provider mutation was authorized.
 *
 * It is NOT:
 *   - CONFIRMED_PROVIDER_FAILURE (the provider was never called)
 *   - AMBIGUOUS_PROVIDER_FAILURE (no external side effect occurred)
 *   - RECONCILIATION_REQUIRED (nothing to reconcile — the provider was not touched)
 *
 * The caller (adapter) catches this and returns a control-plane error. The
 * control plane (action-executor) treats this as a local infrastructure error,
 * NOT a provider failure. The action becomes FAILED (not RECONCILIATION_REQUIRED)
 * because no external side effect occurred — retrying with a new operation is safe.
 */
export class AuditStartFailureError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
  ) {
    super(message);
    this.name = "AuditStartFailureError";
  }
}

// ---------------------------------------------------------------------------
// Phase 12.4.4e.3 — Centralized audit-context policy
// ---------------------------------------------------------------------------

/**
 * Operation class classification (Phase 12.4.4e.3).
 *
 * MUTATING operations (provision, suspend, resume, release) change external
 * provider state. They REQUIRE an authoritative tenant/correlation context
 * and a durable STARTED record BEFORE the provider mutation begins. Missing
 * context → FAIL CLOSED (no provider call).
 *
 * READ operations (getUsage, reconcile) query provider state without mutating
 * it. They have explicit audit semantics: if a tenant context is present,
 * a STARTED→terminal audit record is created (for observability). If no
 * tenant context is present, the read proceeds WITHOUT an audit record (the
 * read has no external side effect, so there is nothing to durably track).
 * This is EXPLICITLY documented — NOT a silent bypass.
 */
export type ProviderOperationClass = "MUTATING" | "READ";

const MUTATING_OPERATIONS = new Set<string>(["provision", "suspend", "resume", "release"]);
const READ_OPERATIONS = new Set<string>(["getUsage", "reconcile"]);

export function classifyProviderOperation(operation: string): ProviderOperationClass {
  if (MUTATING_OPERATIONS.has(operation)) return "MUTATING";
  if (READ_OPERATIONS.has(operation)) return "READ";
  // Unknown operations default to MUTATING (fail-closed) for safety.
  return "MUTATING";
}

/**
 * Phase 12.4.4e.3: Resolve the audit context for a provider operation.
 *
 * This is the CENTRALIZED policy helper that eliminates the per-operation
 * `if (!auditBase)` bypass. It enforces:
 *
 *   MUTATING operations (provision, suspend, resume, release):
 *     - tenantId is REQUIRED. If missing → throw AuditStartFailureError.
 *     - Create a STARTED record, return recordId.
 *     - The provider mutation MUST NOT begin until this returns successfully.
 *
 *   READ operations (getUsage, reconcile):
 *     - If tenantId is present → create a STARTED record, return recordId.
 *     - If tenantId is absent → return null (no audit record). The read
 *       proceeds WITHOUT an audit record. This is EXPLICIT and documented:
 *       reads have no external side effect, so there is nothing to durably
 *       track. Correlation is still preserved in structured logs.
 *
 * This helper does NOT invent tenantId from provider resources, instances,
 * subjects, or entitlements. Tenant authority must be established upstream
 * (executeAction → kernel-bridge → adapter correlation context).
 *
 * @throws AuditStartFailureError if a MUTATING operation lacks tenantId,
 *   or if the STARTED insert fails (DB error).
 */
export async function resolveProviderOperationAuditContext(
  input: ProviderOperationRecordInput,
): Promise<string | null> {
  const opClass = classifyProviderOperation(input.operation);

  if (opClass === "MUTATING") {
    // MUTATING: tenantId is REQUIRED. Fail closed if missing.
    if (!input.tenantId) {
      const { logger } = await import("@/lib/logger");
      logger.error("provider_operation.mutation_missing_tenant_context", {
        operation: input.operation,
        bindingId: input.bindingId,
        providerInstanceId: input.providerInstanceId,
        actionId: input.actionId,
        requestId: input.requestId,
        reason: "MUTATING operation requires authoritative tenant context; provider mutation prohibited (fail closed)",
      });
      throw new AuditStartFailureError(
        `MUTATING operation ${input.operation} requires authoritative tenant context — provider mutation prohibited`,
        input.operation,
      );
    }
    // tenantId present → create STARTED record (throws on DB failure).
    return startProviderOperation(input);
  }

  // READ: tenantId is optional. If present, create STARTED record. If absent,
  // return null (no audit record — explicitly documented).
  if (!input.tenantId) {
    const { logger } = await import("@/lib/logger");
    logger.info("provider_operation.read_no_tenant_context", {
      operation: input.operation,
      bindingId: input.bindingId,
      providerInstanceId: input.providerInstanceId,
      actionId: input.actionId,
      requestId: input.requestId,
      reason: "READ operation without tenant context; proceeding without audit record (no external side effect)",
    });
    return null;
  }

  return startProviderOperation(input);
}

/**
 * Phase 12.4.4e (P0-2) + Phase 12.4.4e.1 (durable identity):
 * Update a STARTED record with the terminal outcome.
 *
 * Phase 12.4.4e.2: recordId is now `string` (non-nullable). In production,
 * startProviderOperation either returns a valid recordId OR throws
 * AuditStartFailureError (fail closed — the provider mutation never begins).
 * There is no production path where completeProviderOperation is called with
 * a null recordId. The null-check is kept for defensive backward compatibility
 * with the deprecated recordProviderOperation test helper, but it logs a
 * high-severity error and does NOT create a duplicate.
 *
 * FAILURES HERE DO NOT AFFECT THE PROVIDER RESULT:
 *   The caller has already received the provider's result (success/failure).
 *   If this terminal update fails (DB error), the provider result remains
 *   authoritative — the control-plane execution does NOT become FAILED merely
 *   because the audit write failed. The record stays STARTED (the STARTED
 *   insert succeeded) and is recoverable/reconcilable.
 */
export async function completeProviderOperation(
  recordId: string | null,
  input: ProviderOperationRecordInput & {
    outcome: ProviderOperationState;
    outcomeDetail?: Record<string, unknown> | null;
    providerResourceId?: string | null;
    reconciliationState?: string | null;
  },
): Promise<void> {
  const { logger } = await import("@/lib/logger");
  const completedAt = new Date();

  // Phase 12.4.4e.1 — DURABLE OPERATION IDENTITY:
  // ONE provider mutation = ONE ProviderOperationRecord. The generated
  // ProviderOperationRecord.id is the durable identity of the operation
  // attempt. NEVER create a second record as a fallback.
  //
  // Phase 12.4.4e.2: In production, recordId is always non-null (startProviderOperation
  // throws on failure). The null-check is defensive only.
  //
  // Case 1: No STARTED record exists (defensive — should not happen in production).
  // Do NOT create a terminal record — that would be a SECOND operation identity.
  if (!recordId) {
    logger.error("provider_operation.complete_no_started_record", {
      operation: input.operation,
      outcome: input.outcome,
      bindingId: input.bindingId,
      actionId: input.actionId,
      tenantId: input.tenantId,
      reason: "STARTED insert failed earlier; cannot create a terminal record without a STARTED predecessor (would violate ONE-mutation-ONE-record invariant)",
    });
    return;
  }

  try {
    // Case 2: Conditional terminal update — DB-authoritative fence.
    // Only the worker holding the STARTED record can transition it.
    const updated = await db.providerOperationRecord.updateMany({
      where: { id: recordId, state: "STARTED" },
      data: {
        state: input.outcome,
        outcome: input.outcome,
        outcomeDetail: input.outcomeDetail ? JSON.stringify(input.outcomeDetail) : null,
        providerResourceId: input.providerResourceId ?? null,
        reconciliationState: input.reconciliationState ?? null,
        completedAt,
      },
    });

    if (updated.count > 0) {
      // Success — the record transitioned STARTED → terminal.
      return;
    }

    // Case 3: UPDATE affected 0 rows. Re-read the record to determine its
    // current state. Do NOT create a duplicate.
    const existing = await db.providerOperationRecord.findUnique({
      where: { id: recordId },
      select: { state: true, outcome: true },
    });

    if (!existing) {
      // The record was deleted (should not happen in production). Do NOT
      // fabricate a second operation.
      logger.error("provider_operation.complete_record_missing", {
        recordId,
        operation: input.operation,
        outcome: input.outcome,
        bindingId: input.bindingId,
        actionId: input.actionId,
        tenantId: input.tenantId,
        reason: "STARTED record not found during terminal update; refusing to create a duplicate (would violate ONE-mutation-ONE-record invariant)",
      });
      return;
    }

    if (existing.state === "STARTED") {
      // The record is still STARTED — the update failed transiently.
      // Preserve STARTED. Do NOT create a duplicate.
      logger.error("provider_operation.complete_update_zero_rows_started", {
        recordId,
        operation: input.operation,
        attemptedOutcome: input.outcome,
        currentState: existing.state,
        bindingId: input.bindingId,
        actionId: input.actionId,
        tenantId: input.tenantId,
        reason: "terminal UPDATE affected 0 rows; record is still STARTED; preserving STARTED (no duplicate created)",
      });
      return;
    }

    // The record is already terminal (completed by a concurrent worker or a
    // recovery path). DB state wins. Do NOT overwrite.
    logger.info("provider_operation.complete_already_terminal", {
      recordId,
      operation: input.operation,
      attemptedOutcome: input.outcome,
      currentState: existing.state,
      currentOutcome: existing.outcome,
      reason: "record already terminal; DB state wins; no overwrite",
    });
    return;
  } catch (err) {
    // Case 4: The UPDATE itself threw (DB error). Do NOT create a duplicate.
    // The record stays STARTED (if it exists) and is recoverable/reconcilable.
    logger.error("provider_operation.complete_update_threw", {
      recordId,
      operation: input.operation,
      outcome: input.outcome,
      bindingId: input.bindingId,
      actionId: input.actionId,
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
      reason: "terminal UPDATE threw; preserving STARTED (no duplicate created); provider result remains authoritative",
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Legacy recorder — DEPRECATED, kept for backward compat with tests that
// call recordProviderOperation directly. New code should use
// startProviderOperation + completeProviderOperation.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use startProviderOperation + completeProviderOperation instead.
 *
 * This function is kept for backward compat with tests that need to create a
 * SYNTHETIC terminal record directly (e.g., 12.4.4e.7 which simulates a failed
 * provider operation for incident-lookup testing). It does NOT go through the
 * STARTED lifecycle — it directly inserts a terminal record.
 *
 * Production code MUST NOT call this. Production code uses the
 * startProviderOperation + completeProviderOperation lifecycle, which
 * enforces the ONE-mutation-ONE-record invariant.
 */
export async function recordProviderOperation(
  input: ProviderOperationRecordInput & {
    outcome: ProviderOperationState;
    outcomeDetail?: Record<string, unknown> | null;
  },
): Promise<void> {
  const { logger } = await import("@/lib/logger");
  const now = new Date();
  try {
    await db.providerOperationRecord.create({
      data: {
        operation: input.operation,
        state: input.outcome,
        outcome: input.outcome,
        outcomeDetail: input.outcomeDetail ? JSON.stringify(input.outcomeDetail) : null,
        providerResourceId: input.providerResourceId ?? null,
        bindingId: input.bindingId ?? null,
        providerInstanceId: input.providerInstanceId ?? null,
        providerType: input.providerType ?? null,
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        intentId: input.intentId ?? null,
        decisionId: input.decisionId ?? null,
        actionId: input.actionId ?? null,
        sessionId: input.sessionId ?? null,
        providerKey: input.providerKey ?? null,
        reconciliationState: input.reconciliationState ?? null,
        startedAt: now,
        completedAt: now,
      },
    });
  } catch (err) {
    logger.warn("provider_operation.record_failed", {
      operation: input.operation,
      outcome: input.outcome,
      bindingId: input.bindingId,
      actionId: input.actionId,
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
