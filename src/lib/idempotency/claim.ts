/**
 * Phase 12.3.2 — DB-authoritative idempotency primitive.
 *
 * Phase 12.3.2.1: The lease is now RENEWABLE via a heartbeat while execute()
 * runs, with fenced ownership (claimId). This closes the split-brain race the
 * architect identified:
 *
 *   THE BUG (pre-12.3.2.1):
 *     Worker A claims (lease = 5 min).
 *     Worker A executes for > 5 min (e.g. a slow payment provider).
 *     Reclaim worker sees IN_PROGRESS + expired lease → transitions to FAILED.
 *     Worker A's side effect actually completes (the payment goes through).
 *     Result: the record says FAILED even though the payment succeeded.
 *     A retry may initiate a SECOND payment. Split-brain outcome.
 *
 *   THE FIX (12.3.2.1):
 *     Worker A claims (lease = 5 min, claimId = random UUID).
 *     Worker A starts execute(). A heartbeat (setInterval) renews the lease
 *       every RENEWAL_INTERVAL_MS via a fenced update:
 *         WHERE claimId = X AND state = IN_PROGRESS
 *       The fenced update means only the claim owner can renew. A stale owner
 *       (whose claim was reclaimed) cannot extend the lease.
 *     Reclaim worker runs but the lease is fresh (heartbeat renewed it).
 *       Operation STAYS IN_PROGRESS.
 *     Worker A completes → fenced update to COMPLETED.
 *     Exactly one side effect.
 *
 *   CRASH RECOVERY:
 *     Worker A claims.
 *     Worker A crashes (heartbeat stops, process dies).
 *     Lease genuinely expires (no renewal).
 *     Reclaim worker → FAILED.
 *     A later retry gets deterministic FAILED semantics.
 *
 * This mirrors the Phase 11.2 session-execution-slot pattern: fenced ownership
 * + heartbeat renewal + conditional terminal transitions.
 *
 * ARCHITECTURE
 * ============
 *
 *   claim (INSERT, unique on (scope, key), claimId = UUID) → IN_PROGRESS
 *     ↓
 *     ├─ start heartbeat (renews lease every RENEWAL_INTERVAL_MS via fenced update)
 *     ├─ execute()
 *     │    ├─ succeeds → fenced UPDATE state=COMPLETED (WHERE claimId=X AND state=IN_PROGRESS)
 *     │    └─ fails   → fenced UPDATE state=FAILED   (WHERE claimId=X AND state=IN_PROGRESS)
 *     └─ stop heartbeat
 *
 *   concurrent request → P2002 unique violation → poll for terminal state
 *
 * The fenced updates guarantee:
 *   - Only the claim owner can renew the lease or transition to a terminal state.
 *   - A stale owner (reclaimed) gets 0 rows affected → detects the loss.
 *   - The reclaim worker only transitions IN_PROGRESS → FAILED when the lease
 *     has genuinely expired (the owner is not renewing).
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

export type IdempotencyClaim = {
  scope: string;
  key: string;
  state: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  resultJson: string | null;
  failureJson: string | null;
  payloadHash: string | null;
  claimId: string | null;
};

export type IdempotencyResult<T> =
  | { kind: "completed"; value: T; replayed: boolean }
  | { kind: "failed"; error: StoredFailure };

export type StoredFailure = {
  errorClass: ErrorClass;
  message: string;
  statusCode: number;
  safeMessage?: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default lease duration. A claim's lease expires after this if the owner
 * is not actively renewing it (heartbeat). 5 minutes — matches Phase 11.
 */
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/**
 * How often the heartbeat renews the lease while execute() runs.
 * Must be substantially shorter than the lease so that a single missed
 * heartbeat doesn't let the lease expire. 1/5 of the lease — even 4 missed
 * heartbeats in a row still leave time before expiry.
 */
const RENEWAL_INTERVAL_MS = 60 * 1000; // 1 minute (lease is 5 min)

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 30 * 1000; // 30 seconds max to wait for a concurrent op

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash a request payload for conflict detection.
 * Pass the JSON.stringify() of the request body (or a canonical subset of it).
 */
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

/**
 * A fenced lease renewal context. The heartbeat uses this to renew the lease
 * periodically. If a renewal fails (claim was reclaimed), the context flags
 * the loss so the execute() completion can detect it.
 */
type LeaseContext = {
  claimId: string;
  scope: string;
  key: string;
  leaseMs: number;
  /** Set to true if a fenced renewal failed (claim was reclaimed). */
  lost: boolean;
  /** The interval handle, used to stop the heartbeat. */
  heartbeatHandle: ReturnType<typeof setInterval> | null;
};

/**
 * Start the heartbeat that renews the lease while execute() runs.
 * The renewal is fenced: WHERE claimId = X AND state = IN_PROGRESS.
 * If the renewal fails (0 rows), the claim was reclaimed — flag the loss.
 */
function startLeaseHeartbeat(ctx: LeaseContext): void {
  ctx.heartbeatHandle = setInterval(async () => {
    if (ctx.lost) return; // already lost — don't keep trying
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
        // The claim was reclaimed (lease genuinely expired and a reclaim
        // worker transitioned it to FAILED). We are now a stale owner.
        // Flag the loss — the execute() completion will detect it.
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
      // Transient DB error — don't flag as lost yet (the next heartbeat will retry).
      // If the DB is genuinely down, the lease will eventually expire and the
      // reclaim worker will handle it.
      logger.warn("idempotency.heartbeat_renewal_error", {
        scope: ctx.scope,
        key: ctx.key,
        claimId: ctx.claimId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, RENEWAL_INTERVAL_MS);
}

/**
 * Stop the heartbeat. Called after execute() completes (success or failure).
 */
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
 * Run an operation exactly once per (scope, key) pair. The INSERT is the atomic
 * claim — concurrent requests lose the race and poll for the terminal result.
 *
 * Phase 12.3.2.1: The lease is renewable via a heartbeat while execute() runs.
 * A long-running side effect (e.g. a slow payment provider) cannot be reclaimed
 * as long as the owner is alive and renewing. Only a genuine crash (heartbeat
 * stops) leads to lease expiry and reclamation.
 *
 * Behavior:
 *   - First caller: claims (INSERT IN_PROGRESS, claimId=UUID), starts heartbeat,
 *     executes, fenced-update to COMPLETED/FAILED, stops heartbeat.
 *   - Concurrent caller (P2002 on INSERT): polls until COMPLETED or FAILED.
 *     - COMPLETED → returns the stored result (replay).
 *     - FAILED → throws the stored failure.
 *   - Conflicting payload (same key, different payloadHash): 409 Conflict.
 *   - Stale owner (claim reclaimed during execute): fenced completion update
 *     returns 0 rows → throws 409 (the side effect ran but the result is
 *     orphaned — the caller must retry with a new key).
 *
 * @throws AppError("conflict", 409) if the key is reused with a different payload.
 * @throws AppError("conflict", 409) if the operation is still IN_PROGRESS after POLL_TIMEOUT_MS.
 * @throws AppError("conflict", 409) if the claim was reclaimed during execute (stale owner).
 * @throws (re-thrown) the stored failure if the operation previously FAILED.
 */
export async function runIdempotentOperation<T>(input: {
  scope: string;
  key: string;
  payloadHash?: string | null;
  principal?: Principal;
  leaseMs?: number;
  execute: () => Promise<T>;
}): Promise<T> {
  const { scope, key } = input;
  if (!scope || !key) {
    throw new AppError("validation", "scope and key are required for idempotency", 400, "Idempotency scope and key are required.");
  }

  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const claimId = randomUUID();

  // Step 1: Try to CLAIM the operation via INSERT.
  // This is the atomic primitive — if two requests race, only one INSERT succeeds.
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
        claimExpiresAt: new Date(Date.now() + leaseMs),
      },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) {
      // Not a unique constraint violation — a real DB error. Re-throw.
      throw err;
    }
    // P2002: another request already claimed this (scope, key).
    // Do NOT execute the side effect. Poll for the terminal result.
    return pollForTerminalResult<T>(scope, key, input.payloadHash ?? null);
  }

  // Step 2: We hold the claim. Start the heartbeat, then execute.
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
    const result = await input.execute();

    // Stop the heartbeat before the terminal update.
    stopHeartbeat(leaseCtx);

    // Store the result via a FENCED update: only the claim owner can transition
    // to COMPLETED. If the claim was reclaimed (lease expired, heartbeat failed),
    // this returns 0 rows — the result is orphaned.
    const resultJson = JSON.stringify(result);
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
      // The claim was reclaimed while we were executing. The side effect ran
      // (e.g. the payment went through) but we cannot store the result — the
      // record now says FAILED. This is the split-brain edge case.
      //
      // We log it as a critical error and throw 409. The caller must retry with
      // a new idempotency key. The caller's retry will see the FAILED record and
      // (depending on the failure semantics) may or may not re-execute.
      //
      // IMPORTANT: this can only happen if the heartbeat FAILED to renew the
      // lease for > leaseMs (e.g. the DB was unreachable for 5+ minutes). Under
      // normal operation, the heartbeat keeps the lease alive and this branch
      // is unreachable.
      logger.error("idempotency.claim_reclaimed_during_execute", {
        scope,
        key,
        claimId,
        message: "Claim was reclaimed during execute; side effect ran but result could not be stored. Possible split-brain — caller must retry with a new key.",
      });
      throw new AppError(
        "conflict",
        "Idempotency claim was reclaimed during execute (lease renewal failed)",
        409,
        "Your request took too long and the idempotency lease could not be renewed. Please retry with a new idempotency key.",
      );
    }

    logger.info("idempotency.operation_completed", { scope, key, claimId });
    return result;
  } catch (err) {
    // Stop the heartbeat.
    stopHeartbeat(leaseCtx);

    // The side effect failed. Dead-letter via a FENCED update: only the claim
    // owner can transition to FAILED. If the claim was already reclaimed (and
    // possibly re-executed by a new claimant), this returns 0 rows — we don't
    // overwrite the new claimant's state.
    const failure = serializeFailure(err);
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
      // The claim was reclaimed before we could store the failure. The
      // reclaim worker already marked it FAILED (with a "lease expired" message),
      // or a new claimant may have re-claimed and is now executing. Either way,
      // we don't overwrite. Log and re-throw the original error.
      logger.warn("idempotency.failure_not_stored", {
        scope,
        key,
        claimId,
        message: "Claim was reclaimed before failure could be stored. The reclaim worker or a new claimant owns the state.",
      });
    } else {
      logger.warn("idempotency.operation_failed", {
        scope,
        key,
        claimId,
        errorClass: failure.errorClass,
        statusCode: failure.statusCode,
      });
    }

    // Re-throw the original error (it's already classified).
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Polling: concurrent request waits for the claim holder to finish
// ---------------------------------------------------------------------------

async function pollForTerminalResult<T>(scope: string, key: string, payloadHash: string | null): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  // First, check for payload conflict. If the claim exists with a different
  // payloadHash, this is a protocol error (key reuse with different payload).
  const existing = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { state: true, payloadHash: true, resultJson: true, failureJson: true },
  });

  if (existing) {
    // Payload conflict check.
    if (payloadHash && existing.payloadHash && existing.payloadHash !== payloadHash) {
      throw new AppError(
        "conflict",
        `Idempotency key "${key}" was already used with a different payload`,
        409,
        "This idempotency key was already used for a different request. Use a new key for a new request.",
      );
    }

    // If already terminal, return the stored result / re-throw the failure.
    if (existing.state === "COMPLETED") {
      logger.info("idempotency.replay", { scope, key });
      return JSON.parse(existing.resultJson!) as T;
    }
    if (existing.state === "FAILED") {
      const failure = deserializeFailure(existing.failureJson!);
      throw new AppError(failure.errorClass, failure.message, failure.statusCode, failure.safeMessage);
    }
    // IN_PROGRESS — fall through to polling.
  }

  // Poll until terminal or timeout.
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const op = await db.idempotencyOperation.findUnique({
      where: { scope_key: { scope, key } },
      select: { state: true, resultJson: true, failureJson: true },
    });
    if (!op) {
      // Should not happen — the claim existed moments ago. Treat as conflict.
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
    // Still IN_PROGRESS — keep polling.
  }

  // Timed out — the claim holder is still executing after POLL_TIMEOUT_MS.
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
// Reclaim: expired-lease recovery (crashed worker)
// ---------------------------------------------------------------------------

/**
 * Transition expired IN_PROGRESS operations to FAILED.
 *
 * Phase 12.3.2.1: This is the CRASH RECOVERY path. It only transitions an
 * operation to FAILED when the lease has genuinely expired — meaning the
 * owner's heartbeat has stopped renewing it. A long-running legitimate
 * execution (whose heartbeat is active) will have a fresh lease and will
 * NOT be reclaimed.
 *
 * The invariant:
 *   "An IN_PROGRESS operation is only reclaimed if its owner has stopped
 *    renewing the lease for > leaseMs."
 *
 * Returns the number of operations reclaimed.
 */
export async function reclaimExpiredIdempotencyOperations(): Promise<number> {
  const result = await db.idempotencyOperation.updateMany({
    where: {
      state: "IN_PROGRESS",
      claimExpiresAt: { lt: new Date() },
    },
    data: {
      state: "FAILED",
      failureJson: JSON.stringify({
        errorClass: "internal",
        message: "Operation lease expired (executing process may have crashed)",
        statusCode: 500,
      } satisfies StoredFailure),
      completedAt: new Date(),
      claimExpiresAt: null,
    },
  });
  if (result.count > 0) {
    logger.warn("idempotency.reclaimed_expired", { count: result.count });
  }
  return result.count;
}

// ---------------------------------------------------------------------------
// Query: inspect an operation's state (for testing/debugging)
// ---------------------------------------------------------------------------

export async function getIdempotencyOperation(scope: string, key: string): Promise<IdempotencyClaim | null> {
  const op = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { scope: true, key: true, state: true, resultJson: true, failureJson: true, payloadHash: true, claimId: true },
  });
  if (!op) return null;
  return op as IdempotencyClaim;
}

// ---------------------------------------------------------------------------
// Test helpers (exported for adversarial tests)
// ---------------------------------------------------------------------------

/**
 * Manually set the lease expiry to a past time, simulating a heartbeat that
 * stopped (crashed worker). Used by adversarial tests to prove the reclaim
 * path without waiting for the full lease duration.
 *
 * This is fenced on claimId to ensure only the owner's lease is manipulated.
 */
export async function _testForceLeaseExpiry(scope: string, key: string, claimId: string): Promise<void> {
  await db.idempotencyOperation.updateMany({
    where: { scope, key, claimId, state: "IN_PROGRESS" },
    data: { claimExpiresAt: new Date(Date.now() - 1000) },
  });
}

/**
 * Get the current claimId for an operation (for test assertions).
 */
export async function _getClaimId(scope: string, key: string): Promise<string | null> {
  const op = await db.idempotencyOperation.findUnique({
    where: { scope_key: { scope, key } },
    select: { claimId: true },
  });
  return op?.claimId ?? null;
}
