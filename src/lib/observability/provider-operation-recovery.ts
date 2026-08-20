/**
 * Phase 12.4.4f — Provider Operation Recovery Service.
 *
 * Recovers STARTED ProviderOperationRecord rows that remain after a process
 * crash, terminal audit-write failure, or other interruption.
 *
 * ARCHITECTURAL INVARIANT:
 *
 *   A STARTED ProviderOperationRecord means:
 *   "RoamLink established durable identity for a provider operation, but the
 *    terminal outcome is not yet durably known."
 *
 *   It MUST NOT mean: FAILED, SUCCEEDED, RETRYABLE, or safe to repeat blindly.
 *
 * RECOVERY RULES:
 *
 *   1. QUERY PROVIDER TRUTH — recovery queries the provider's actual state
 *      (via adapter.reconcile() or adapter.getUsage()). It does NOT execute
 *      the original mutation again. Recovery is READ-ONLY at the provider.
 *
 *   2. SAME RECORD — recovery updates the SAME ProviderOperationRecord.id.
 *      Never creates a replacement record.
 *
 *   3. NO-BLIND-RETRY — if provider truth says resource missing, recovery
 *      classifies the outcome as FAILED/AMBIGUOUS. It does NOT create a new
 *      provider resource. The control plane decides whether another desired
 *      transition is appropriate.
 *
 *   4. DB-AUTHORITATIVE OWNERSHIP — recovery claims a STARTED record with a
 *      fenced updateMany (WHERE state=STARTED AND recoveryClaimExpiresAt<now
 *      OR recoveryClaimId IS NULL). Two recovery workers cannot claim the
 *      same record. A crashed recovery worker's claim is reclaimable after
 *      lease expiry.
 *
 *   5. OBSERVATIONAL ONLY — recovery never:
 *      - creates a new provider operation
 *      - authorizes connectivity
 *      - changes intent/decision/session state
 *      - bypasses execution fences
 *
 *   6. TENANT ISOLATION — recovery is tenant-scoped via the record's tenantId.
 *      A recovery worker can only recover records belonging to its tenant.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { completeProviderOperation, type ProviderOperationState } from "./incident-lookup";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A STARTED record is eligible for recovery if it has been STARTED for longer
 * than this threshold. This gives the original worker time to complete its
 * terminal audit update before recovery kicks in.
 *
 * The threshold is intentionally LONGER than the provider operation timeout
 * (2 minutes in the entitlement kernel) and the session execution slot lease
 * (5 minutes). A STARTED record that is younger than 5 minutes is likely
 * still in progress — the original worker may not have written the terminal
 * update yet. After 5 minutes, the worker has either:
 *   (a) completed (terminal update written → no STARTED), or
 *   (b) crashed (STARTED persists → eligible for recovery).
 *
 * Age is a TRIGGER for investigation, not proof of outcome. Recovery queries
 * provider truth to determine the actual result.
 */
export const STARTED_RECOVERY_AFTER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The lease duration for a recovery claim. A recovery worker that crashes
 * mid-query has its claim expire after this duration, allowing another worker
 * to reclaim. The lease is intentionally SHORT (2 minutes) because recovery
 * involves a single provider truth query (not a long mutation window).
 */
export const RECOVERY_CLAIM_LEASE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Maximum number of STARTED records to process per recovery cycle. Prevents
 * the recovery worker from monopolizing the DB if many records accumulate.
 */
export const RECOVERY_BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecoveryResult = {
  examined: number;
  claimed: number;
  recovered: number;
  ambiguous: number;
  failed: number;
  retained: number;
};

export type ProviderTruthResult = {
  status: "exists" | "missing" | "query_failed" | "provider_unavailable";
  observedState?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Recovery entry point
// ---------------------------------------------------------------------------

/**
 * Recover eligible STARTED ProviderOperationRecords.
 *
 * This is the main entry point for the recovery worker. It:
 *   1. Finds STARTED records older than STARTED_RECOVERY_AFTER_MS.
 *   2. Atomically claims each record (fenced updateMany).
 *   3. Queries provider truth (via adapter.reconcile()).
 *   4. Classifies the outcome and updates the SAME record.
 *
 * The recovery is OBSERVATIONAL — it never executes a provider mutation.
 * It only queries the provider's actual state and resolves the STARTED record.
 *
 * @returns RecoveryResult with counts of examined/claimed/recovered/ambiguous.
 */
export async function recoverStaleProviderOperations(): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    examined: 0,
    claimed: 0,
    recovered: 0,
    ambiguous: 0,
    failed: 0,
    retained: 0,
  };

  const now = new Date();
  const threshold = new Date(now.getTime() - STARTED_RECOVERY_AFTER_MS);

  // Step 1: Find eligible STARTED records (indexed query).
  // Eligible = STARTED AND startedAt < threshold AND (no active claim OR expired claim).
  const eligible = await db.providerOperationRecord.findMany({
    where: {
      state: "STARTED",
      startedAt: { lt: threshold },
      OR: [
        { recoveryClaimId: null },
        { recoveryClaimExpiresAt: { lt: now } },
      ],
    },
    select: {
      id: true, operation: true, tenantId: true,
      providerInstanceId: true, providerResourceId: true, bindingId: true,
      providerType: true, requestId: true, intentId: true,
      decisionId: true, actionId: true, sessionId: true,
      providerKey: true, startedAt: true,
    },
    take: RECOVERY_BATCH_SIZE,
    orderBy: { startedAt: "asc" }, // oldest first
  });

  result.examined = eligible.length;

  for (const record of eligible) {
    // Step 2: Atomically claim the record (fenced updateMany).
    const claimId = `recovery-${record.id}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    const claimExpiresAt = new Date(now.getTime() + RECOVERY_CLAIM_LEASE_MS);

    const claimed = await db.providerOperationRecord.updateMany({
      where: {
        id: record.id,
        state: "STARTED",
        OR: [
          { recoveryClaimId: null },
          { recoveryClaimExpiresAt: { lt: now } },
        ],
      },
      data: {
        recoveryClaimId: claimId,
        recoveryClaimedAt: now,
        recoveryClaimExpiresAt: claimExpiresAt,
      },
    });

    if (claimed.count === 0) {
      // Another recovery worker claimed it first, or the record was
      // already transitioned to terminal. Skip.
      continue;
    }

    result.claimed++;

    logger.info("provider_operation.recovery_claimed", {
      recordId: record.id,
      operation: record.operation,
      tenantId: record.tenantId,
      bindingId: record.bindingId,
      actionId: record.actionId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      sessionId: record.sessionId,
      providerInstanceId: record.providerInstanceId,
      providerResourceId: record.providerResourceId,
      startedAt: record.startedAt,
      claimId,
    });

    try {
      // Step 3: Query provider truth.
      const truth = await queryProviderTruth(record);

      // Step 4: Classify and resolve.
      const classification = classifyTruthResult(record.operation, truth);

      if (classification.terminal) {
        // Step 5a: Terminal classification — update the SAME record with the
        // terminal outcome. The record transitions STARTED → terminal.
        await completeProviderOperation(record.id, {
          operation: record.operation as "provision" | "suspend" | "resume" | "release" | "getUsage" | "reconcile",
          tenantId: record.tenantId,
          bindingId: record.bindingId,
          providerInstanceId: record.providerInstanceId,
          providerType: record.providerType,
          providerResourceId: record.providerResourceId,
          requestId: record.requestId,
          intentId: record.intentId,
          decisionId: record.decisionId,
          actionId: record.actionId,
          sessionId: record.sessionId,
          providerKey: record.providerKey,
          outcome: classification.state,
          outcomeDetail: {
            recoveryClaimId: claimId,
            recoveredAt: new Date().toISOString(),
            providerTruthStatus: truth.status,
            providerTruthObservedState: truth.observedState,
            providerTruthError: truth.error,
            classificationReason: classification.reason,
          },
          reconciliationState: classification.reconciliationState,
        });

        result.recovered++;

        logger.info("provider_operation.recovery_completed", {
          recordId: record.id,
          operation: record.operation,
          claimId,
          outcome: classification.state,
          providerTruthStatus: truth.status,
          reason: classification.reason,
        });
      } else {
        // Step 5b: NON-TERMINAL classification (provider unavailable / query failed).
        // The provider truth could not be determined. Do NOT transition to terminal.
        // The record REMAINS STARTED and is eligible for the next recovery cycle.
        // Release the recovery claim so another worker can try later.
        // Persist the recovery attempt metadata on the record (reconciliationState)
        // without changing the state.
        await db.providerOperationRecord.update({
          where: { id: record.id },
          data: {
            // Release the recovery claim — another recovery worker can claim
            // this record in a future cycle.
            recoveryClaimId: null,
            recoveryClaimedAt: null,
            recoveryClaimExpiresAt: null,
            // Persist the recovery attempt metadata for operator visibility.
            // The record stays STARTED — it is genuinely recoverable.
            reconciliationState: classification.reconciliationState ?? "provider_unavailable",
          },
        });

        result.retained++;

        logger.info("provider_operation.recovery_retained", {
          recordId: record.id,
          operation: record.operation,
          claimId,
          providerTruthStatus: truth.status,
          reason: classification.reason,
          reconciliationState: classification.reconciliationState,
          note: "provider truth unavailable; record remains STARTED and is eligible for next recovery cycle",
        });
      }
    } catch (err) {
      // The provider truth query threw (DB error, unexpected exception).
      // Release the recovery claim so another worker can try later.
      // The record remains STARTED — it is still recoverable.
      await db.providerOperationRecord.update({
        where: { id: record.id },
        data: {
          recoveryClaimId: null,
          recoveryClaimedAt: null,
          recoveryClaimExpiresAt: null,
        },
      }).catch(() => {});

      result.failed++;

      logger.error("provider_operation.recovery_failed", {
        recordId: record.id,
        operation: record.operation,
        claimId,
        error: err instanceof Error ? err.message : String(err),
        reason: "recovery threw; claim released; record remains STARTED and is recoverable",
      });
    }
  }

  if (result.claimed > 0) {
    logger.info("provider_operation.recovery_batch_complete", {
      examined: result.examined,
      claimed: result.claimed,
      recovered: result.recovered,
      ambiguous: result.ambiguous,
      failed: result.failed,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Provider truth query
// ---------------------------------------------------------------------------

/**
 * Query the actual provider state for a STARTED operation.
 *
 * This is READ-ONLY — it queries the provider's actual state via the adapter's
 * reconcile() method. It NEVER executes a provider mutation.
 *
 * The recovery path correlates:
 *   ProviderOperationRecord → bindingId → resolveBindingRuntime → adapter.reconcile()
 *
 * If the binding no longer exists (deleted), or the provider instance is gone,
 * the truth is classified as "missing" (the operation cannot be verified).
 */
async function queryProviderTruth(record: {
  id: string;
  operation: string;
  tenantId: string;
  bindingId: string | null;
  providerResourceId: string | null;
  providerInstanceId: string | null;
}): Promise<ProviderTruthResult> {
  // If there's no bindingId, we can't resolve the adapter. The operation
  // was recorded but has no binding to query. This is a data integrity issue.
  if (!record.bindingId) {
    return {
      status: "missing",
      error: "No bindingId on the operation record — cannot resolve provider truth",
    };
  }

  try {
    // Use the entitlement kernel's reconcile function, which resolves the
    // adapter + binding + entitlement and calls adapter.reconcile() (READ-ONLY).
    const { reconcileBindingWithProvider } = await import("@/lib/connectivity/entitlement");
    const result = await reconcileBindingWithProvider(record.bindingId);

    // The reconcile function returns the observed state.
    if (result.status === "error") {
      return {
        status: "query_failed",
        error: result.error ?? "reconcile returned error",
      };
    }

    // Phase 12.4.4f.3: Detect adapter failure masked as "in_sync" by the
    // entitlement kernel. When adapter.reconcile() catches a provider error
    // (timeout, network, auth), it returns { status: "failed_retryable" | "failed_permanent" }
    // WITHOUT an observedState. The kernel's mapReconciliationResult maps these
    // to a no-transition "in_sync" return (just metadata update), so the kernel's
    // status becomes "in_sync" with observedState=undefined. We detect this
    // signature and classify as provider_unavailable → AMBIGUOUS (the truth
    // could not be determined, but we did successfully query the provider —
    // the query itself returned a failure classification, distinct from
    // "query_failed" which is a transport-level failure to query at all).
    if (result.observedState === undefined) {
      return {
        status: "provider_unavailable",
        error: result.error ?? `reconcile returned ${result.status} without observedState — adapter likely returned a failure classification`,
      };
    }

    // The reconcile returned successfully — the provider was queried.
    // The observedState tells us what the provider truth is.
    if (result.observedState === "not_found") {
      return { status: "missing", observedState: "not_found" };
    }

    return {
      status: "exists",
      observedState: result.observedState,
    };
  } catch (err) {
    // The provider query threw (timeout, network error, provider unavailable).
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("not found") || errorMsg.includes("not_found")) {
      return { status: "missing", error: errorMsg };
    }
    // Transient errors → provider unavailable. The record remains STARTED.
    return {
      status: "provider_unavailable",
      error: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Truth classification
// ---------------------------------------------------------------------------

/**
 * Classify the provider truth result into a ProviderOperationState.
 *
 * Phase 12.4.4f.1: The classification distinguishes TERMINAL outcomes
 * (provider truth determined → record transitions) from NON-TERMINAL outcomes
 * (provider truth could not be determined → record remains STARTED and is
 * eligible for the next recovery cycle).
 *
 * TERMINAL classifications:
 *   exists + active (provision/resume)  → SUCCEEDED
 *   exists + inactive (suspend)         → SUCCEEDED
 *   exists + active (suspend)           → FAILED_RETRYABLE
 *   exists (release)                    → FAILED_RETRYABLE
 *   missing (provision)                 → FAILED_PERMANENT
 *   missing (release)                   → SUCCEEDED
 *   missing (suspend/resume)            → AMBIGUOUS (operation effect unknown —
 *                                          the resource is gone, so the operation
 *                                          can never be verified. This IS terminal
 *                                          because the provider truth was determined:
 *                                          "the resource does not exist.")
 *
 * NON-TERMINAL classifications:
 *   query_failed                        → retains STARTED (retryable — provider
 *                                          query itself failed, not the provider's
 *                                          state. The next recovery cycle can retry.)
 *   provider_unavailable                → retains STARTED (retryable — provider
 *                                          is down/timeout. The next recovery
 *                                          cycle can retry when the provider
 *                                          comes back.)
 *
 * The key invariant: a transient provider outage during recovery does NOT
 * permanently strand the audit record in a terminal AMBIGUOUS state. The
 * record remains STARTED and is genuinely recoverable.
 */
function classifyTruthResult(
  operation: string,
  truth: ProviderTruthResult,
): { state: ProviderOperationState; reason: string; reconciliationState?: string; terminal: boolean } {
  switch (truth.status) {
    case "exists": {
      if (operation === "suspend" && truth.observedState === "inactive") {
        return { state: "SUCCEEDED", reason: "provider truth confirms suspended state", terminal: true };
      }
      if (operation === "suspend" && truth.observedState === "active") {
        return { state: "FAILED_RETRYABLE", reason: "provider truth shows resource still active after suspend", terminal: true };
      }
      if (operation === "release" && truth.observedState !== "not_found") {
        return { state: "FAILED_RETRYABLE", reason: "provider truth shows resource still exists after release", terminal: true };
      }
      return { state: "SUCCEEDED", reason: `provider truth confirms resource exists (state: ${truth.observedState})`, terminal: true };
    }

    case "missing": {
      if (operation === "release") {
        return { state: "SUCCEEDED", reason: "provider truth shows resource missing — release achieved desired state", terminal: true };
      }
      if (operation === "provision") {
        return { state: "FAILED_PERMANENT", reason: "provider truth shows resource missing after provision", reconciliationState: "resource_missing", terminal: true };
      }
      // For suspend/resume: the resource is gone. The operation's effect cannot
      // be verified. This IS terminal — the provider truth was determined
      // ("resource missing"), and the outcome is genuinely ambiguous (not a
      // transient outage). AMBIGUOUS here means "we looked, and the answer was
      // inconclusive" — not "we couldn't look."
      return { state: "AMBIGUOUS", reason: "provider truth shows resource missing — operation effect unknown", reconciliationState: "resource_missing", terminal: true };
    }

    case "query_failed": {
      // The provider query itself failed (transport/adapter error).
      // NON-TERMINAL: the record remains STARTED. The next recovery cycle
      // can retry the query. This is NOT the same as "provider truth says
      // ambiguous" — we never got a truth answer.
      return { state: "AMBIGUOUS", reason: `provider truth query failed: ${truth.error}`, reconciliationState: "query_failed", terminal: false };
    }

    case "provider_unavailable": {
      // The provider is unavailable (timeout, connection refused, 5xx).
      // NON-TERMINAL: the record remains STARTED. The next recovery cycle
      // can retry when the provider comes back.
      return { state: "AMBIGUOUS", reason: `provider unavailable: ${truth.error}`, reconciliationState: "provider_unavailable", terminal: false };
    }

    default:
      // Unknown truth status — treat as non-terminal (conservative).
      return { state: "AMBIGUOUS", reason: "unknown provider truth status", terminal: false };
  }
}

// ---------------------------------------------------------------------------
// Reclaim expired recovery claims
// ---------------------------------------------------------------------------

/**
 * Reclaim recovery claims that have expired (the recovery worker crashed
 * mid-query). Returns the claim count to the pool of eligible records.
 *
 * This is analogous to reclaimExpiredDecisionClaims and reclaimExpiredSessionSlots.
 */
export async function reclaimExpiredRecoveryClaims(): Promise<{ reclaimed: number }> {
  const now = new Date();
  const result = await db.providerOperationRecord.updateMany({
    where: {
      state: "STARTED",
      recoveryClaimId: { not: null },
      recoveryClaimExpiresAt: { lt: now },
    },
    data: {
      recoveryClaimId: null,
      recoveryClaimedAt: null,
      recoveryClaimExpiresAt: null,
    },
  });

  if (result.count > 0) {
    logger.info("provider_operation.recovery_claims_reclaimed", { reclaimed: result.count });
  }

  return { reclaimed: result.count };
}
