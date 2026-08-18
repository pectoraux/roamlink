/**
 * Phase 12.3.2 — DB-authoritative idempotency primitive.
 *
 * This module replaces the race-prone `runIdempotent()` in lib/orders/idempotency.ts.
 *
 * ARCHITECTURE
 * ============
 *
 * The INSERT is the atomic claim. There is no read-then-write window.
 *
 *   claim (INSERT, unique on (scope, key)) → IN_PROGRESS
 *     ↓
 *     ├─ execute succeeds → UPDATE state=COMPLETED, resultJson=...
 *     ├─ execute fails   → UPDATE state=FAILED, failureJson=...
 *     └─ concurrent request → P2002 unique violation → poll for terminal state
 *
 * A concurrent request that loses the claim race (Prisma throws P2002 on the
 * INSERT) does NOT execute the side effect. It polls the claim record until it
 * reaches a terminal state (COMPLETED | FAILED), then:
 *   - COMPLETED → returns the stored result (clean replay)
 *   - FAILED    → throws the stored failure (dead-letter, caller retries with a new key)
 *
 * PAYLOAD CONFLICT DETECTION
 * ==========================
 *
 * If two requests use the same idempotency key but different payloads, the second
 * is rejected with 409 Conflict. This catches "idempotency key reuse with a
 * different request" — a protocol error, not a retry.
 *
 * LEASE / CRASH RECOVERY
 * ======================
 *
 * A claim has a lease (default 5 minutes). If the executing process crashes
 * while IN_PROGRESS, the claim's lease expires. A reclaim worker
 * (reclaimExpiredIdempotencyOperations) transitions expired IN_PROGRESS → FAILED
 * so a future request with the same key gets a clean failure (not a hung poll).
 *
 * USAGE
 * =====
 *
 *   const result = await runIdempotentOperation({
 *     scope: "checkout",
 *     key: body.idempotencyKey,
 *     payloadHash: hashPayload(body),
 *     principal: { type: "session", id: user.id, tenantId: ctx.tenantId },
 *     execute: async () => createOrder(...),
 *   });
 *
 * The `execute` callback runs AT MOST ONCE per (scope, key) pair. If the process
 * crashes mid-execute, the lease expires and the operation is dead-lettered.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AppError, type ErrorClass } from "@/lib/errors";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";

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

const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 minutes
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
// Primitive: runIdempotentOperation
// ---------------------------------------------------------------------------

/**
 * Run an operation exactly once per (scope, key) pair. The INSERT is the atomic
 * claim — concurrent requests lose the race and poll for the terminal result.
 *
 * Behavior:
 *   - First caller: claims (INSERT IN_PROGRESS), executes, stores result/failure.
 *   - Concurrent caller (P2002 on INSERT): polls until COMPLETED or FAILED.
 *     - COMPLETED → returns the stored result (replay=true).
 *     - FAILED → throws the stored failure.
 *   - Conflicting payload (same key, different payloadHash): 409 Conflict.
 *   - Replayed key (same key, same payloadHash, already COMPLETED): returns stored result.
 *
 * @throws AppError("conflict", 409) if the key is reused with a different payload.
 * @throws AppError("conflict", 409) if the operation is still IN_PROGRESS after POLL_TIMEOUT_MS.
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
        claimExpiresAt: new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS)),
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

  // Step 2: We hold the claim. Execute the side effect.
  try {
    const result = await input.execute();

    // Store the result and transition to COMPLETED.
    // Use a conditional updateMany to avoid overwriting a concurrent reclaim
    // (if the lease expired and a reclaim worker marked it FAILED while we
    // were executing). Only transition if still IN_PROGRESS.
    const resultJson = JSON.stringify(result);
    const updated = await db.idempotencyOperation.updateMany({
      where: { scope, key, state: "IN_PROGRESS" },
      data: {
        state: "COMPLETED",
        resultJson,
        completedAt: new Date(),
        claimExpiresAt: null,
      },
    });

    if (updated.count === 0) {
      // The lease expired and a reclaim worker transitioned this to FAILED
      // while we were executing. This is a rare edge case. The result is
      // orphaned — we executed the side effect but cannot store the result.
      // Log it; the caller will see a conflict on retry.
      logger.error("idempotency.lease_expired_during_execute", {
        scope,
        key,
        message: "Operation lease expired during execute; result could not be stored.",
      });
      throw new AppError(
        "conflict",
        "Idempotency operation lease expired during execute",
        409,
        "Your request took too long and the idempotency lease expired. Please retry with a new idempotency key.",
      );
    }

    logger.info("idempotency.operation_completed", { scope, key });
    return result;
  } catch (err) {
    // The side effect failed. Dead-letter the operation so a future request
    // with the same key gets the failure (not a silent retry).
    const failure = serializeFailure(err);

    // Only transition to FAILED if still IN_PROGRESS (same reclaim-safety guard).
    await db.idempotencyOperation.updateMany({
      where: { scope, key, state: "IN_PROGRESS" },
      data: {
        state: "FAILED",
        failureJson: JSON.stringify(failure),
        completedAt: new Date(),
        claimExpiresAt: null,
      },
    }).catch(() => {});

    logger.warn("idempotency.operation_failed", {
      scope,
      key,
      errorClass: failure.errorClass,
      statusCode: failure.statusCode,
    });

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
 * A worker that crashed mid-execute leaves the claim IN_PROGRESS with an expired
 * lease. This function dead-letters those claims so future requests with the same
 * key get a clean failure instead of polling forever.
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
    select: { scope: true, key: true, state: true, resultJson: true, failureJson: true, payloadHash: true },
  });
  if (!op) return null;
  return op as IdempotencyClaim;
}
