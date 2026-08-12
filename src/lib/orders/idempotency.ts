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
 * This module provides a transaction-safe "run once" helper.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Run an operation exactly once per idempotency key. If the key was already
 * used, returns the previously-stored result.
 */
export async function runIdempotent<T>(input: {
  key: string;
  scope: string; // logical scope, e.g. "checkout"
  /**
   * Lookup any previously-stored result for this key (from your own table).
   * Returns the existing record if present.
   */
  findExisting: () => Promise<T | null>;
  /** Execute and persist the operation. */
  execute: () => Promise<T>;
}): Promise<T> {
  const existing = await input.findExisting();
  if (existing != null) {
    logger.info("idempotent.replay", { scope: input.scope, key: input.key });
    return existing;
  }
  return input.execute();
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
