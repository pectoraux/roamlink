/**
 * Idempotency helpers.
 *
 * A network retry must NEVER result in one payment -> two eSIMs, or one payment
 * -> two provider orders. We enforce idempotency via:
 *   - Unique idempotencyKey on Order (DB constraint)
 *   - Unique idempotencyKey on Payment (DB constraint)
 *   - Unique idempotencyKey on TopUp (DB constraint)
 *   - Provider createOrder / provisionESIM / topUp all idempotent by key
 *   - WebhookEvent dedup by (provider, externalId)
 *
 * Phase 12.3.2: The canonical DB-authoritative primitive is now
 * `runIdempotentOperation` in lib/idempotency/claim.ts. It uses an INSERT as
 * the atomic claim (no read-then-write window) and a state machine
 * (IN_PROGRESS → COMPLETED | FAILED) with lease-based crash recovery.
 *
 * The legacy `runIdempotent` below is retained for backward compatibility but
 * now delegates to the new primitive. New code should call
 * `runIdempotentOperation` directly.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { runIdempotentOperation, type Principal } from "@/lib/idempotency/claim";

/**
 * Run an operation exactly once per idempotency key. If the key was already
 * used, returns the previously-stored result.
 *
 * Phase 12.3.2: This now delegates to the DB-authoritative primitive. The
 * `findExisting` / `execute` split is preserved for API compatibility, but the
 * atomic claim is the INSERT into IdempotencyOperation — the `findExisting`
 * callback is only invoked to replay a result that was stored in a domain
 * table (e.g. Order) rather than in IdempotencyOperation.resultJson.
 *
 * For NEW code, prefer `runIdempotentOperation` directly — it stores the result
 * in IdempotencyOperation and does not require a `findExisting` callback.
 */
export async function runIdempotent<T>(input: {
  key: string;
  scope: string; // logical scope, e.g. "checkout"
  /**
   * Lookup any previously-stored result for this key (from your own table).
   * Returns the existing record if present.
   *
   * Phase 12.3.2 note: This is now advisory only. The atomic claim is the
   * IdempotencyOperation INSERT. This callback is invoked AFTER the claim is
   * held, to check if a domain table already has the result (for callers that
   * store results in their own tables rather than in IdempotencyOperation).
   */
  findExisting?: () => Promise<T | null>;
  /** Execute and persist the operation. */
  execute: () => Promise<T>;
  principal?: Principal;
}): Promise<T> {
  // Delegate to the DB-authoritative primitive. The claim INSERT is atomic.
  // The findExisting callback is invoked inside execute() — if the domain
  // table already has the result (e.g. from a prior completed operation whose
  // IdempotencyOperation record was pruned), return it without re-executing.
  return runIdempotentOperation<T>({
    scope: input.scope,
    key: input.key,
    principal: input.principal,
    execute: async () => {
      if (input.findExisting) {
        const existing = await input.findExisting();
        if (existing != null) {
          logger.info("idempotent.domain_replay", { scope: input.scope, key: input.key });
          return existing;
        }
      }
      return input.execute();
    },
  });
}

/** Generate a fresh idempotency key. */
export function generateIdempotencyKey(scope: string): string {
  return `${scope}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Audit log helper — records an auditable action. Every financial operation is
 * auditable (Rule 5).
 */
export async function audit(input: {
  userId?: string;
  orderId?: string;
  tenantId?: string;
  action: string;
  entity: string;
  entityId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: input.userId ?? null,
      orderId: input.orderId ?? null,
      tenantId: input.tenantId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      ip: input.ip ?? null,
    },
  });
}
