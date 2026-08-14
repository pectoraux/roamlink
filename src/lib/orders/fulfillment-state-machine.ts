/**
 * Fulfillment State Machine — enforces legal fulfillment-state transitions
 * for an order's `fulfillmentStatus` field (Phase 2C).
 *
 *   pending → provisioning → success
 *                       ↘   ↘ failed
 *                            ↘ unknown
 *                            ↘ reconciliation_required
 *
 * This state machine is INDEPENDENT of (and runs in parallel with) the legacy
 * OrderStatus state machine in `./state-machine.ts`. Both must agree for an
 * order to be considered complete.
 *
 * `transitionFulfillment` performs a conditional UPDATE — it only updates the
 * order if the current state matches the expected `from` state. This makes
 * concurrent fulfillment attempts safe (only one wins).
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export type FulfillmentStatus =
  | "pending"
  | "provisioning"
  | "success"
  | "failed"
  | "unknown"
  | "reconciliation_required";

const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  pending: ["provisioning", "failed", "unknown"],
  provisioning: ["success", "failed", "unknown", "reconciliation_required"],
  success: ["reconciliation_required"],
  failed: ["provisioning", "reconciliation_required"],
  unknown: ["provisioning", "success", "failed", "reconciliation_required"],
  reconciliation_required: ["provisioning", "success", "failed", "unknown"],
};

export function canTransitionFulfillment(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): boolean {
  return FULFILLMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertFulfillmentTransition(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): void {
  if (!canTransitionFulfillment(from, to)) {
    throw new AppError(
      "conflict",
      `Illegal fulfillment transition ${from} -> ${to}`,
      409,
      "This fulfillment action is not allowed in the current state.",
    );
  }
}

/**
 * Atomically transition an order's fulfillmentStatus. Only succeeds if the
 * current state matches `from`. Optionally merges extra field updates (e.g.
 * setting `fulfillmentExternalReference` or `supplierOfferId`).
 *
 * Returns true if the transition was applied, false if the current state
 * did not match `from` (no-op for concurrent callers).
 */
export async function transitionFulfillment(
  orderId: string,
  from: FulfillmentStatus,
  to: FulfillmentStatus,
  extraUpdate: Record<string, unknown> = {},
): Promise<boolean> {
  assertFulfillmentTransition(from, to);

  // Conditional UPDATE: only matches if the current fulfillmentStatus === from.
  const result = await db.order.updateMany({
    where: { id: orderId, fulfillmentStatus: from },
    data: { fulfillmentStatus: to, ...extraUpdate },
  });

  if (result.count === 0) {
    logger.info("fulfillment.transition_noop", { orderId, from, to });
    return false;
  }

  logger.info("fulfillment.transitioned", { orderId, from, to });
  return true;
}

/** Read the current fulfillment status of an order. */
export async function getFulfillmentStatus(orderId: string): Promise<FulfillmentStatus> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { fulfillmentStatus: true },
  });
  if (!order) {
    throw new AppError("not_found", `Order ${orderId} not found`, 404, "Order not found.");
  }
  return order.fulfillmentStatus as FulfillmentStatus;
}
