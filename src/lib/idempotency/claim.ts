/**
 * Phase 12.3.2 — DB-authoritative idempotency primitive.
 *
 * Phase 12.3.2.2: Crash-after-side-effect semantics.
 *
 * The architect's audit of 08afb1b found a deeper problem than the lease race:
 *   - Worker A claims, calls provider (payment accepted), crashes before COMPLETED.
 *   - Lease expires, reclaim marks it FAILED.
 *   - Caller retries with a new key → provider receives a SECOND payment.
 *
 * The heartbeat solved live long-running execution. It cannot solve
 * crash-after-external-side-effect-but-before-durable-completion. That is the
 * classic distributed-systems boundary: RoamLink cannot atomically commit its
 * DB row and an external provider's side effect.
 *
 * THE FIX (12.3.2.2):
 *   - Reclaim transitions IN_PROGRESS → RECONCILIATION_REQUIRED (NOT FAILED).
 *   - RECONCILIATION_REQUIRED means "the external outcome is UNKNOWN".
 *   - The caller MUST NOT retry with a new key (that could duplicate the side effect).
 *   - A reconciliation worker queries the provider with the SAME providerKey to
 *     determine the actual outcome, then transitions to COMPLETED or FAILED.
 *   - The providerKey is passed to the provider during execute() so the provider
 *     deduplicates on it.
 *
 * STATE MACHINE:
 *   IN_PROGRESS → COMPLETED              (execute succeeded)
 *   IN_PROGRESS → FAILED                (execute threw a CONFIRMED failure)
 *   IN_PROGRESS → RECONCILIATION_REQUIRED (lease expired / worker crashed)
 *   RECONCILIATION_REQUIRED → COMPLETED  (reconciliation: provider says SUCCESS)
 *   RECONCILIATION_REQUIRED → FAILED    (reconciliation: provider says NOT_FOUND/FAILED)
 *
 * Phase 12.3.2.1 (heartbeat + fenced ownership) is retained — it ensures the
 * lease stays alive while execute() runs. This phase (12.3.2.2) adds the
 * recovery semantics for when the heartbeat genuinely stops (crash).
 *
 * ARCHITECTURE
 * ============
 *
 *   claim (INSERT, claimId=UUID, providerKey=...) → IN_PROGRESS
 *     ↓
 *     ├─ start heartbeat (fenced renewal on claimId)
 *     ├─ execute(providerKey) — caller MUST pass providerKey to the provider
 *     │    ├─ succeeds → fenced UPDATE state=COMPLETED
 *     │    └─ fails   → fenced UPDATE state=FAILED
 *     └─ stop heartbeat
 *
 *   reclaim worker (lease expired):
 *     IN_PROGRESS → RECONCILIATION_REQUIRED
 *
 *   reconcileOperation(scope, key, queryProvider):
 *     RECONCILIATION_REQUIRED → queryProvider(providerKey)
 *       ├─ provider says SUCCESS → UPDATE state=COMPLETED, resultJson=...
 *       └─ provider says FAILED/NOT_FOUND → UPDATE state=FAILED, failureJson=...
 *
 *   concurrent request (P2002 on INSERT):
 *     poll for terminal state (COMPLETED | FAILED).
 *     If RECONCILIATION_REQUIRED → 409 "outcome unknown, do not retry".
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AppError, type ErrorClass } from "@/lib/errors";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Principal = {
  type: "session" | "api_key";
  id: string;
  tenantId: string | null;
};

export type OperationState = "IN_PROGRESS" | "COMPLETED" | "FAILED" | "RECONCILIATION_REQUIRED" | "RECONCILIATION_CLAIMED";

export type IdempotencyClaim = {
  scope: string;
  key: string;
  state: OperationState;
  resultJson: string | null;
  failureJson: string | null;
  payloadHash: string | null;
  claimId: string | null;
  providerKey: string | null;
  reconciledAt: Date | null;
  reconciliationClaimId: string | null;
};

export type StoredFailure = {
  errorClass: ErrorClass;
  message: string;
  statusCode: number;
  safeMessage?: string;
};

/**
 * Phase 12.3.2.3: The outcome of execute(). The caller MUST classify the result:
 *
 *   - SUCCESS: the operation completed. The value is stored and replayed.
 *
 *   - CONFIRMED_FAILURE: the provider EXPLICITLY rejected the request (e.g.
 *     validation error, card declined, insufficient funds). The failure is
 *     stored as FAILED. Safe to retry with a new key.
 *
 *   - AMBIGUOUS_EXTERNAL_FAILURE: the provider's response was lost or ambiguous
 *     (e.g. timeout, ECONNRESET, connection reset). The side effect's outcome
 *     is UNKNOWN — the provider may have accepted the request. The operation
 *     transitions to RECONCILIATION_REQUIRED. The caller MUST NOT retry with a
 *     new key. A reconciliation worker must query the provider.
 *
 * The architectural rule:
 *   "Only provider-confirmed negative outcomes may become FAILED.
 *    Ambiguous external errors must become RECONCILIATION_REQUIRED."
 *
 * This is the core distinction that prevents duplicate payments when a
 * provider's response is lost after it accepted the request.
 */
export type OperationOutcome<T> =
  | { outcome: "SUCCESS"; value: T }
  | { outcome: "CONFIRMED_FAILURE"; failure: StoredFailure }
  | { outcome: "AMBIGUOUS_EXTERNAL_FAILURE"; failure: StoredFailure };

/**
 * The result of a provider reconciliation query. The reconciliation worker
 * calls the provider with the providerKey and receives one of these outcomes.
 */
export type ReconciliationOutcome<T> =
  | { outcome: "SUCCESS"; value: T }
  | { outcome: "FAILED"; failure: StoredFailure }
  | { outcome: "NOT_FOUND"; failure: StoredFailure }
  | { outcome: "STILL_PENDING" };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const RENEWAL_INTERVAL_MS = 60 * 1000;
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashPayload(payload: unknown): string {
  const str = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHash("sha256").update(str).digest("hex");
}

function serializeFailure(err: unknown): StoredFailure {
  if (err instanceof AppError) {
    return {
      errorClass: err.errorClass,
      message: err.message,
      statusCode: err.statusCode,
      safeMessage: err.safeMessage,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    errorClass: "internal" as ErrorClass,
    message,
    statusCode: 500,
  };
}

function deserializeFailure(json: string): StoredFailure {
  const parsed = JSON.parse(json) as StoredFailure;
  return parsed;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Fenced renewal: heartbeat keeps the lease alive while execute() runs
// ---------------------------------------------------------------------------

type LeaseContext = {
  claimId: string;
  scope: string;
  key: string;
  leaseMs: number;
  lost: boolean;
  heartbeatHandle: ReturnType<typeof setInterval> | null;
};

function startLeaseHeartbeat(ctx: LeaseContext): void {
  ctx.heartbeatHandle = setInterval(async () => {
    if (ctx.lost) return;
    try {
      const renewed = await db.idempotencyOperation.updateMany({
        where: {
          scope: ctx.scope,
          key: ctx.key,
          claimId: ctx.claimId,
          state: "IN_PROGRESS",
        },
        data: {
          claimExpiresAt: new Date(Date.now() + ctx.leaseMs),
        },
      });
      if (renewed.count === 0) {
        ctx.lost = true;
        logger.error("idempotency.heartbeat_renewal_failed", {
          scope: ctx.scope,
          key: ctx.key,
          claimId: ctx.claimId,
          message: "Lease renewal returned 0 rows — claim was reclaimed.",
        });
        stopHeartbeat(ctx);
      }
    } catch (err) {
      logger.warn("idempotency.heartbeat_renewal_error", {
        scope: ctx.scope,
        key: ctx.key,
        claimId: ctx.claimId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, RENEWAL_INTERVAL_MS);
}

function stopHeartbeat(ctx: LeaseContext): void {
  if (ctx.heartbeatHandle) {
    clearInterval(ctx.heartbeatHandle);
    ctx.heartbeatHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Primitive: runIdempotentOperation
// ---------------------------------------------------------------------------

/**
 * Run an operation exactly once per (scope, key) pair.
 *
 * Phase 12.3.2.2: The `providerKey` is passed to execute() so the caller can
 * forward it to the external provider. If the worker crashes after the provider
 * accepted the request, the reconciliation worker uses the SAME providerKey to
 * query the provider's actual outcome.
 *
 * Behavior:
 *   - First caller: claims (INSERT IN_PROGRESS, claimId=UUID, providerKey),
 *     starts heartbeat, executes, fenced-update to COMPLETED/FAILED.
 *   - Concurrent caller (P2002): polls for terminal state.
 *     - COMPLETED → returns stored result (replay).
 *     - FAILED → throws stored failure.
 *     - RECONCILIATION_REQUIRED → throws 409 "outcome unknown, do not retry".
 *   - Stale owner (claim reclaimed during execute): fenced completion returns 0
 *     rows → the operation is now RECONCILIATION_REQUIRED (the reclaim worker
 *     transitioned it). The caller gets a 409 with "outcome unknown".
 *
 * @param providerKey The key to pass to the external provider for deduplication.
 *   If the operation has no external side effect, this can be null — but then
 *   RECONCILIATION_REQUIRED is terminal (no reconciliation is possible, since
 *   there's no provider to query).
 */
/**
 * Run an operation exactly once per (scope, key) pair.
 *
 * Phase 12.3.2.3: The execute() callback now returns an `OperationOutcome<T>`
 * which classifies the result as SUCCESS, CONFIRMED_FAILURE, or
 * AMBIGUOUS_EXTERNAL_FAILURE. Only CONFIRMED_FAILURE transitions to FAILED;
 * AMBIGUOUS_EXTERNAL_FAILURE transitions to RECONCILIATION_REQUIRED (the
 * outcome is unknown — the provider may have accepted the request).
 *
 * Phase 12.3.2.3: If `isExternal` is true, `providerKey` is REQUIRED. An
 * external side-effect operation without a providerKey is rejected before
 * execution — it would be unreconcilable if the worker crashed.
 *
 * Behavior:
 *   - First caller: claims (INSERT IN_PROGRESS, claimId=UUID, providerKey),
 *     starts heartbeat, executes, classified-update to COMPLETED/FAILED/
 *     RECONCILIATION_REQUIRED based on the OperationOutcome.
 *   - Concurrent caller (P2002): polls for terminal state.
 *     - COMPLETED → returns stored result (replay).
 *     - FAILED → throws stored failure.
 *     - RECONCILIATION_REQUIRED / RECONCILIATION_CLAIMED → throws 409 "outcome unknown".
 *   - Ambiguous external error during execute: transitions to RECONCILIATION_REQUIRED.
 *     The caller gets a 409 — the outcome is unknown, do not retry.
 *
 * @param isExternal If true, the operation performs an external side effect
 *   (payment, provisioning) and providerKey is REQUIRED. Defaults to true.
 * @param providerKey The provider-side idempotency key. REQUIRED if isExternal.
 *   Pass to the provider in execute() so the provider deduplicates on it.
 */
export async function runIdempotentOperation<T>(input: {
  scope: string;
  key: string;
  payloadHash?: string | null;
  principal?: Principal;
  leaseMs?: number;
  /**
   * Phase 12.3.2.3: If true (default), the operation performs an external side
   * effect and providerKey is REQUIRED. If false, the operation is a pure DB
   * operation and providerKey is optional (RECONCILIATION_REQUIRED is terminal
   * if no providerKey is set).
   */
  isExternal?: boolean;
  /** The provider-side idempotency key. REQUIRED if isExternal is true. */
  providerKey?: string | null;
  /**
   * The operation to execute. Receives the providerKey (to pass to the provider).
   * Returns an OperationOutcome that classifies the result.
   *
   * For backward compatibility, if execute() returns a raw value (not an
   * OperationOutcome), it is treated as SUCCESS. If execute() throws, the
   * error is classified: AppError with errorClass "validation"/"not_found"/
   * "conflict"/"authorization"/"auth" is a CONFIRMED_FAILURE; everything else
   * (including network errors, timeouts, provider errors) is an
   * AMBIGUOUS_EXTERNAL_FAILURE.
   */
  execute: (providerKey: string) => Promise<OperationOutcome<T> | T>;
}): Promise<T> {
  const { scope, key } = input;
  if (!scope || !key) {
    throw new AppError("validation", "scope and key are required for idempotency", 400, "Idempotency scope and key are required.");
  }

  const isExternal = input.isExternal ?? true;
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const claimId = randomUUID();

  // Phase 12.3.2.3: providerKey is REQUIRED for external side-effect operations.
  // Without it, a crash after the provider accepted the request would be
  // permanently unreconcilable.
  let providerKey = input.providerKey ?? null;
  if (isExternal) {
    if (!providerKey) {
      // Default to the RoamLink key if the caller didn't supply one — but
      // only for external operations. This ensures reconciliation is always
      // possible. (We log a warning that the caller should supply one explicitly.)
      providerKey = key;
      logger.warn("idempotency.provider_key_defaulted", {
        scope, key,
        message: "providerKey was not supplied for an external operation; defaulting to the RoamLink key. Callers should supply an explicit providerKey.",
      });
    }
  }

  // Step 1: CLAIM via INSERT.
  try {
    await db.idempotencyOperation.create({
      data: {
        scope,
        key,
        state: "IN_PROGRESS",
        payloadHash: input.payloadHash ?? null,
        tenantId: input.principal?.tenantId ?? null,
        principalId: input.principal?.id ?? null,
        principalType: input.principal?.type ?? null,
        claimId,
        providerKey,
        claimExpiresAt: new Date(Date.now() + leaseMs),
      },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) {
      throw err;
    }
    // P2002: another request already claimed this. Poll for the terminal result.
    return pollForTerminalResult<T>(scope, key, input.payloadHash ?? null);
  }

  // Step 2: We hold the claim. Start heartbeat, then execute.
  const leaseCtx: LeaseContext = {
    claimId,
    scope,
    key,
    leaseMs,
    lost: false,
    heartbeatHandle: null,
  };
  startLeaseHeartbeat(leaseCtx);

  try {
    const rawResult = await input.execute(providerKey!);

    // Classify the result.
    let outcome: OperationOutcome<T>;
    if (rawResult && typeof rawResult === "object" && "outcome" in rawResult) {
      outcome = rawResult as OperationOutcome<T>;
    } else {
      // Backward compatibility: raw return value is treated as SUCCESS.
      outcome = { outcome: "SUCCESS", value: rawResult as T };
    }

    stopHeartbeat(leaseCtx);

    if (outcome.outcome === "SUCCESS") {
      // Fenced update to COMPLETED.
      const resultJson = JSON.stringify(outcome.value);
      const updated = await db.idempotencyOperation.updateMany({
        where: { scope, key, claimId, state: "IN_PROGRESS" },
        data: {
          state: "COMPLETED",
          resultJson,
          completedAt: new Date(),
          claimExpiresAt: null,
        },
      });

      if (updated.count === 0) {
        // Claim was reclaimed during execute. Outcome is unknown.
        logger.error("idempotency.claim_reclaimed_during_execute", {
          scope, key, claimId, providerKey,
          message: "Claim was reclaimed during execute; side effect outcome is UNKNOWN. Reconciliation required.",
        });
        const reclaimedErr = new AppError(
          "conflict",
          "Idempotency claim was reclaimed during execute (side effect outcome unknown)",
          409,
          "Your request's outcome could not be confirmed. The operation is pending reconciliation — do not retry with a new key.",
        );
        (reclaimedErr as any)._outcomeClassified = true;
        throw reclaimedErr;
      }

      logger.info("idempotency.operation_completed", { scope, key, claimId });
      return outcome.value;
    }

    if (outcome.outcome === "CONFIRMED_FAILURE") {
      // Provider explicitly rejected. Safe to retry with a new key → FAILED.
      const failure = outcome.failure;
      const updated = await db.idempotencyOperation.updateMany({
        where: { scope, key, claimId, state: "IN_PROGRESS" },
        data: {
          state: "FAILED",
          failureJson: JSON.stringify(failure),
          completedAt: new Date(),
          claimExpiresAt: null,
        },
      }).catch(() => ({ count: 0 }));

      if (updated.count === 0) {
        logger.warn("idempotency.confirmed_failure_not_stored", {
          scope, key, claimId,
          message: "Claim was reclaimed before CONFIRMED_FAILURE could be stored.",
        });
      } else {
        logger.warn("idempotency.operation_failed_confirmed", {
          scope, key, claimId,
          errorClass: failure.errorClass, statusCode: failure.statusCode,
        });
      }

      const confirmedErr = new AppError(failure.errorClass, failure.message, failure.statusCode, failure.safeMessage);
      (confirmedErr as any)._outcomeClassified = true;
      throw confirmedErr;
    }

    // AMBIGUOUS_EXTERNAL_FAILURE → RECONCILIATION_REQUIRED.
    // The provider's response was lost or ambiguous. The outcome is UNKNOWN.
    const failure = outcome.failure;
    const updated = await db.idempotencyOperation.updateMany({
      where: { scope, key, claimId, state: "IN_PROGRESS" },
      data: {
        state: "RECONCILIATION_REQUIRED",
        failureJson: JSON.stringify(failure),
        claimExpiresAt: null,
      },
    }).catch(() => ({ count: 0 }));

    if (updated.count > 0) {
      logger.error("idempotency.ambiguous_external_failure", {
        scope, key, claimId, providerKey,
        errorClass: failure.errorClass, statusCode: failure.statusCode,
        message: "Ambiguous external failure — outcome is UNKNOWN. Reconciliation required.",
      });
    }

    const ambiguousErr = new AppError(
      "conflict",
      "Ambiguous external failure — operation outcome is unknown",
      409,
      "Your request could not be confirmed. The operation is pending reconciliation — do not retry with a new key.",
    );
    (ambiguousErr as any)._outcomeClassified = true;
    throw ambiguousErr;
  } catch (err) {
    stopHeartbeat(leaseCtx);

    // If the error is already an AppError from the outcome classification above,
    // it has already been handled (the state transition happened). Re-throw.
    if (err instanceof AppError && (err as any)._outcomeClassified) {
      throw err;
    }

    // The execute() callback threw without returning an OperationOutcome.
    // Classify the error:
    //   - AppError with a "client" errorClass (validation, not_found, conflict,
    //     authorization, auth) is a CONFIRMED_FAILURE — these are deterministic
    //     rejections that happen before any external side effect.
    //   - Everything else (network errors, timeouts, provider errors, internal
    //     errors) is an AMBIGUOUS_EXTERNAL_FAILURE — the outcome is unknown.
    const failure = serializeFailure(err);
    const isConfirmedFailure =
      err instanceof AppError &&
      ["validation", "not_found", "conflict", "authorization", "auth"].includes(err.errorClass);

    if (isConfirmedFailure) {
      // CONFIRMED_FAILURE → FAILED.
      const updated = await db.idempotencyOperation.updateMany({
        where: { scope, key, claimId, state: "IN_PROGRESS" },
        data: {
          state: "FAILED",
          failureJson: JSON.stringify(failure),
          completedAt: new Date(),
          claimExpiresAt: null,
        },
      }).catch(() => ({ count: 0 }));

      if (updated.count === 0) {
        logger.warn("idempotency.confirmed_failure_not_stored", {
          scope, key, claimId,
          message: "Claim was reclaimed before CONFIRMED_FAILURE could be stored.",
        });
      } else {
        logger.warn("idempotency.operation_failed_confirmed", {
          scope, key, claimId,
          errorClass: failure.errorClass, statusCode: failure.statusCode,
        });
      }
    } else {
      // AMBIGUOUS_EXTERNAL_FAILURE → RECONCILIATION_REQUIRED.
      const updated = await db.idempotencyOperation.updateMany({
        where: { scope, key, claimId, state: "IN_PROGRESS" },
        data: {
          state: "RECONCILIATION_REQUIRED",
          failureJson: JSON.stringify(failure),
          claimExpiresAt: null,
        },
      }).catch(() => ({ count: 0 }));

      if (updated.count > 0) {
        logger.error("idempotency.ambiguous_external_failure_thrown", {
          scope, key, claimId, providerKey,
          errorClass: failure.errorClass, statusCode: failure.statusCode,
          message: "execute() threw an ambiguous error — outcome is UNKNOWN. Reconciliation required.",
        });
      }

      // Convert the error to a 409 "outcome unknown" so the caller doesn't retry.
      const ambiguousErr = new AppError(
        "conflict",
        "Ambiguous external failure — operation outcome is unknown",
        409,
        "Your request could not be confirmed. The operation is pending reconciliation — do not retry with a new key.",
      );
      (ambiguousErr as any)._outcomeClassified = true;
      throw ambiguousErr;
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Polling: concurrent request waits for the claim holder to finish
// ---------------------------------------------------------------------------

async function pollForTerminalResult<T>(scope: string, key: string, payloadHash: string | null): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  const existing = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { state: true, payloadHash: true, resultJson: true, failureJson: true },
  });

  if (existing) {
    if (payloadHash && existing.payloadHash && existing.payloadHash !== payloadHash) {
      throw new AppError(
        "conflict",
        `Idempotency key "${key}" was already used with a different payload`,
        409,
        "This idempotency key was already used for a different request. Use a new key for a new request.",
      );
    }

    if (existing.state === "COMPLETED") {
      logger.info("idempotency.replay", { scope, key });
      return JSON.parse(existing.resultJson!) as T;
    }
    if (existing.state === "FAILED") {
      const failure = deserializeFailure(existing.failureJson!);
      throw new AppError(failure.errorClass, failure.message, failure.statusCode, failure.safeMessage);
    }
    if (existing.state === "RECONCILIATION_REQUIRED" || existing.state === "RECONCILIATION_CLAIMED") {
      // The prior operation crashed or had an ambiguous external failure.
      // The outcome is UNKNOWN. The caller MUST NOT retry with a new key —
      // a reconciliation worker must resolve this first.
      throw new AppError(
        "conflict",
        "Idempotency operation is pending reconciliation — outcome unknown",
        409,
        "A previous request with this idempotency key could not be confirmed. It is pending reconciliation — do not retry with a new key.",
      );
    }
    // IN_PROGRESS — fall through to polling.
  }

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const op = await db.idempotencyOperation.findUnique({
      where: { scope_key: { scope, key } },
      select: { state: true, resultJson: true, failureJson: true },
    });
    if (!op) {
      throw new AppError("conflict", "Idempotency operation disappeared during poll", 409, "Your request could not be completed. Please retry.");
    }
    if (op.state === "COMPLETED") {
      logger.info("idempotency.replay_after_poll", { scope, key });
      return JSON.parse(op.resultJson!) as T;
    }
    if (op.state === "FAILED") {
      const failure = deserializeFailure(op.failureJson!);
      throw new AppError(failure.errorClass, failure.message, failure.statusCode, failure.safeMessage);
    }
    if (op.state === "RECONCILIATION_REQUIRED" || op.state === "RECONCILIATION_CLAIMED") {
      throw new AppError(
        "conflict",
        "Idempotency operation is pending reconciliation — outcome unknown",
        409,
        "A previous request with this idempotency key could not be confirmed. It is pending reconciliation — do not retry with a new key.",
      );
    }
  }

  throw new AppError(
    "conflict",
    "Idempotency operation is still in progress after poll timeout",
    409,
    "A previous request with this idempotency key is still being processed. Please retry shortly.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Reclaim: expired-lease recovery → RECONCILIATION_REQUIRED (not FAILED)
// ---------------------------------------------------------------------------

/**
 * Transition expired IN_PROGRESS operations to RECONCILIATION_REQUIRED.
 *
 * Phase 12.3.2.2: The reclaim no longer marks operations as FAILED. A crashed
 * worker's side effect may have been accepted by the provider, so the outcome
 * is UNKNOWN. The operation enters RECONCILIATION_REQUIRED, and a
 * reconciliation worker must query the provider (using providerKey) to determine
 * the actual outcome before transitioning to COMPLETED or FAILED.
 *
 * Phase 12.3.2.3: Also reclaims expired RECONCILIATION_CLAIMED operations —
 * a reconciliation worker that crashed while querying the provider leaves the
 * operation in RECONCILIATION_CLAIMED with an expired lease. This transitions
 * it back to RECONCILIATION_REQUIRED so another reconciliation worker can claim it.
 *
 * The invariant:
 *   "A reclaimed operation's outcome is UNKNOWN until reconciliation confirms it."
 *
 * Returns the number of operations reclaimed.
 */
export async function reclaimExpiredIdempotencyOperations(): Promise<number> {
  // 1. Reclaim expired IN_PROGRESS → RECONCILIATION_REQUIRED.
  const result1 = await db.idempotencyOperation.updateMany({
    where: {
      state: "IN_PROGRESS",
      claimExpiresAt: { lt: new Date() },
    },
    data: {
      state: "RECONCILIATION_REQUIRED",
      failureJson: JSON.stringify({
        errorClass: "internal",
        message: "Operation lease expired — external side effect outcome is unknown. Reconciliation required.",
        statusCode: 500,
      } satisfies StoredFailure),
      claimExpiresAt: null,
    },
  });

  // 2. Reclaim expired RECONCILIATION_CLAIMED → RECONCILIATION_REQUIRED.
  // A reconciliation worker crashed while querying the provider. Transition
  // back to RECONCILIATION_REQUIRED so another worker can claim it.
  const result2 = await db.idempotencyOperation.updateMany({
    where: {
      state: "RECONCILIATION_CLAIMED",
      reconciliationClaimExpiresAt: { lt: new Date() },
    },
    data: {
      state: "RECONCILIATION_REQUIRED",
      reconciliationClaimId: null,
      reconciliationClaimExpiresAt: null,
    },
  });

  const total = result1.count + result2.count;
  if (total > 0) {
    logger.warn("idempotency.reclaimed_to_reconciliation", {
      inProgress: result1.count,
      reconciliationClaimed: result2.count,
    });
  }
  return total;
}

// ---------------------------------------------------------------------------
// Reconciliation: query the provider to resolve an UNKNOWN outcome
// ---------------------------------------------------------------------------

const RECONCILIATION_LEASE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Reconcile a RECONCILIATION_REQUIRED operation by querying the provider.
 *
 * Phase 12.3.2.3: The reconciliation now uses a FENCED CLAIM to establish
 * ownership before querying the provider:
 *
 *   RECONCILIATION_REQUIRED
 *     → fenced UPDATE: state = RECONCILIATION_CLAIMED, reconciliationClaimId = UUID
 *     → queryProvider(providerKey)
 *     → fenced UPDATE: state = COMPLETED | FAILED | RECONCILIATION_REQUIRED
 *       (WHERE reconciliationClaimId = X AND state = RECONCILIATION_CLAIMED)
 *
 * This prevents two reconciliation workers from both querying the provider
 * concurrently (which may have side effects, consume rate limits, or return
 * inconsistent snapshots). The fenced claim has a lease; a crashed
 * reconciliation worker's claim is reclaimable after expiry.
 *
 * The reconciliation worker calls `queryProvider(providerKey)` which returns
 * one of:
 *   - SUCCESS → transition to COMPLETED, store the result.
 *   - FAILED / NOT_FOUND → transition to FAILED, store the failure.
 *   - STILL_PENDING → transition back to RECONCILIATION_REQUIRED (retry later).
 *
 * @returns The new state (COMPLETED, FAILED, or RECONCILIATION_REQUIRED if still pending).
 */
export async function reconcileOperation<T>(input: {
  scope: string;
  key: string;
  queryProvider: (providerKey: string) => Promise<ReconciliationOutcome<T>>;
}): Promise<OperationState> {
  const { scope, key } = input;
  const reconciliationClaimId = randomUUID();
  const leaseExpiry = new Date(Date.now() + RECONCILIATION_LEASE_MS);

  // Step 1: FENCED CLAIM — transition RECONCILIATION_REQUIRED → RECONCILIATION_CLAIMED.
  // Only one reconciliation worker can claim it. If another worker already claimed
  // it, this returns 0 rows and we return the current state (RECONCILIATION_CLAIMED).
  const claimResult = await db.idempotencyOperation.updateMany({
    where: { scope, key, state: "RECONCILIATION_REQUIRED" },
    data: {
      state: "RECONCILIATION_CLAIMED",
      reconciliationClaimId,
      reconciliationClaimExpiresAt: leaseExpiry,
    },
  });

  if (claimResult.count === 0) {
    // Either already terminal (COMPLETED/FAILED) or already claimed by another worker.
    const op = await db.idempotencyOperation.findUnique({
      where: { scope_key: { scope, key } },
      select: { state: true },
    });
    return op?.state as OperationState ?? "RECONCILIATION_REQUIRED";
  }

  // Step 2: We hold the reconciliation claim. Query the provider.
  const op = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { providerKey: true },
  });

  const providerKey = op?.providerKey;
  if (!providerKey) {
    // No provider key — we cannot query the provider. Release the claim and leave.
    await db.idempotencyOperation.updateMany({
      where: { scope, key, reconciliationClaimId, state: "RECONCILIATION_CLAIMED" },
      data: {
        state: "RECONCILIATION_REQUIRED",
        reconciliationClaimId: null,
        reconciliationClaimExpiresAt: null,
        reconciledAt: new Date(),
      },
    });
    logger.warn("idempotency.reconcile_no_provider_key", { scope, key });
    return "RECONCILIATION_REQUIRED";
  }

  let outcome: ReconciliationOutcome<T>;
  try {
    outcome = await input.queryProvider(providerKey);
  } catch (err) {
    // The provider query itself failed. Release the claim and leave as RECONCILIATION_REQUIRED.
    // A later reconciliation cycle can retry.
    await db.idempotencyOperation.updateMany({
      where: { scope, key, reconciliationClaimId, state: "RECONCILIATION_CLAIMED" },
      data: {
        state: "RECONCILIATION_REQUIRED",
        reconciliationClaimId: null,
        reconciliationClaimExpiresAt: null,
        reconciledAt: new Date(),
      },
    });
    logger.warn("idempotency.reconcile_query_failed", {
      scope, key, providerKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return "RECONCILIATION_REQUIRED";
  }

  // Step 3: FENCED TERMINAL TRANSITION — only the claim owner can transition.
  if (outcome.outcome === "STILL_PENDING") {
    // The provider hasn't determined the outcome yet. Release the claim.
    await db.idempotencyOperation.updateMany({
      where: { scope, key, reconciliationClaimId, state: "RECONCILIATION_CLAIMED" },
      data: {
        state: "RECONCILIATION_REQUIRED",
        reconciliationClaimId: null,
        reconciliationClaimExpiresAt: null,
        reconciledAt: new Date(),
      },
    });
    logger.info("idempotency.reconcile_still_pending", { scope, key, providerKey });
    return "RECONCILIATION_REQUIRED";
  }

  if (outcome.outcome === "SUCCESS") {
    const resultJson = JSON.stringify(outcome.value);
    const updated = await db.idempotencyOperation.updateMany({
      where: { scope, key, reconciliationClaimId, state: "RECONCILIATION_CLAIMED" },
      data: {
        state: "COMPLETED",
        resultJson,
        failureJson: null,
        completedAt: new Date(),
        reconciledAt: new Date(),
        reconciliationClaimId: null,
        reconciliationClaimExpiresAt: null,
      },
    });
    if (updated.count > 0) {
      logger.info("idempotency.reconciled_to_completed", { scope, key, providerKey });
    }
    return "COMPLETED";
  }

  // FAILED or NOT_FOUND — transition to FAILED.
  const failure = outcome.failure;
  const updated = await db.idempotencyOperation.updateMany({
    where: { scope, key, reconciliationClaimId, state: "RECONCILIATION_CLAIMED" },
    data: {
      state: "FAILED",
      failureJson: JSON.stringify(failure),
      completedAt: new Date(),
      reconciledAt: new Date(),
      reconciliationClaimId: null,
      reconciliationClaimExpiresAt: null,
    },
  });
  if (updated.count > 0) {
    logger.info("idempotency.reconciled_to_failed", {
      scope, key, providerKey,
      errorClass: failure.errorClass, statusCode: failure.statusCode,
    });
  }
  return "FAILED";
}

// ---------------------------------------------------------------------------
// Query: inspect an operation's state (for testing/debugging)
// ---------------------------------------------------------------------------

export async function getIdempotencyOperation(scope: string, key: string): Promise<IdempotencyClaim | null> {
  const op = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: {
      scope: true, key: true, state: true, resultJson: true, failureJson: true,
      payloadHash: true, claimId: true, providerKey: true, reconciledAt: true,
      reconciliationClaimId: true,
    },
  });
  if (!op) return null;
  return op as IdempotencyClaim;
}

// ---------------------------------------------------------------------------
// Test helpers (exported for adversarial tests)
// ---------------------------------------------------------------------------

/**
 * Manually set the lease expiry to a past time, simulating a heartbeat that
 * stopped (crashed worker). Fenced on claimId.
 */
export async function _testForceLeaseExpiry(scope: string, key: string, claimId: string): Promise<void> {
  await db.idempotencyOperation.updateMany({
    where: { scope, key, claimId, state: "IN_PROGRESS" },
    data: { claimExpiresAt: new Date(Date.now() - 1000) },
  });
}

/**
 * Get the current claimId for an operation.
 */
export async function _getClaimId(scope: string, key: string): Promise<string | null> {
  const op = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { claimId: true },
  });
  return op?.claimId ?? null;
}

/**
 * Get the providerKey stored on the operation.
 */
export async function _getProviderKey(scope: string, key: string): Promise<string | null> {
  const op = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { providerKey: true },
  });
  return op?.providerKey ?? null;
}
