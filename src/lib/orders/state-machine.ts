/**
 * Order state machine — enforces legal state transitions.
 *
 * Valid happy path:
 *   PLAN_SELECTED -> CHECKOUT_CREATED -> PAYMENT_PENDING -> PAYMENT_CONFIRMED
 *     -> ESIM_PROVISIONING -> ESIM_PROVISIONED -> COMPLETED
 *
 * Failure paths:
 *   * -> PAYMENT_FAILED
 *   * -> PROVISIONING_FAILED
 *   * -> CANCELLED
 *   * -> REFUNDED
 */

import type { OrderStatus } from "@/types";
import { AppError } from "@/lib/errors";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PLAN_SELECTED: ["CHECKOUT_CREATED", "CANCELLED"],
  CHECKOUT_CREATED: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_PENDING: ["PAYMENT_CONFIRMED", "PAYMENT_FAILED", "CANCELLED"],
  PAYMENT_CONFIRMED: ["ESIM_PROVISIONING", "PROVISIONING_FAILED", "REFUNDED"],
  ESIM_PROVISIONING: ["ESIM_PROVISIONED", "PROVISIONING_FAILED", "REFUNDED"],
  ESIM_PROVISIONED: ["COMPLETED", "PROVISIONING_FAILED", "REFUNDED"],
  COMPLETED: ["REFUNDED"],
  PAYMENT_FAILED: ["PAYMENT_PENDING", "CANCELLED"],
  PROVISIONING_FAILED: ["ESIM_PROVISIONING", "REFUNDED", "CANCELLED"],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      "conflict",
      `Illegal order transition ${from} -> ${to}`,
      409,
      "This action is not allowed in the current state.",
    );
  }
}

export const TERMINAL_STATUSES: OrderStatus[] = ["COMPLETED", "CANCELLED", "REFUNDED"];
export const FAILURE_STATUSES: OrderStatus[] = ["PAYMENT_FAILED", "PROVISIONING_FAILED"];
