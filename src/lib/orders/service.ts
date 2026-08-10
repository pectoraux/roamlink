/**
 * Order service — orchestrates the purchase flow.
 *
 *   PLAN_SELECTED -> CHECKOUT_CREATED -> PAYMENT_PENDING -> PAYMENT_CONFIRMED
 *     -> ESIM_PROVISIONING -> ESIM_PROVISIONED -> COMPLETED
 *
 * Critical business rules enforced here:
 *   - Rule 1/2: eSIM is NEVER provisioned because the frontend says payment
 *     succeeded. Payment is verified server-side.
 *   - Rule 3: An order can only provision once (1:1 order->esim, DB unique).
 *   - Rule 6: Provider data isolated behind adapters.
 *   - Rule 9: Wholesale pricing never exposed (PublicPlan strips it).
 */

import { db } from "@/lib/db";
import { getESIMProvider } from "@/lib/esim";
import { getPaymentProvider } from "@/lib/payments";
import { getCanonicalPlan } from "@/lib/plans/service";
import { assertTransition } from "./state-machine";
import { generateIdempotencyKey, audit } from "./idempotency";
import { logger } from "@/lib/logger";
import { AppError, classifyProviderError } from "@/lib/errors";
import type { OrderStatus, ProvisioningResult } from "@/types";
import type { Currency } from "@/lib/money";
import QRCode from "qrcode";

export type OrderSnapshot = {
  id: string;
  status: OrderStatus;
  amountMinor: number;
  currency: string;
  paymentStatus: string;
  paymentProvider: string | null;
  paymentReference: string | null;
  providerOrderId: string | null;
  planId: string;
  planName: string;
  country: string;
  countryCode: string;
  dataAmountMB: number;
  validityDays: number;
  esimId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function toSnapshot(o: {
  id: string;
  status: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  paymentProvider: string | null;
  paymentReference: string | null;
  providerOrderId: string | null;
  planId: string;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  plan: { id: string; name: string; country: string; countryCode: string; dataAmount: number; validityDays: number };
  esim: { id: string } | null;
}): OrderSnapshot {
  return {
    id: o.id,
    status: o.status as OrderStatus,
    amountMinor: o.amount,
    currency: o.currency,
    paymentStatus: o.paymentStatus,
    paymentProvider: o.paymentProvider,
    paymentReference: o.paymentReference,
    providerOrderId: o.providerOrderId,
    planId: o.planId,
    planName: o.plan.name,
    country: o.plan.country,
    countryCode: o.plan.countryCode,
    dataAmountMB: o.plan.dataAmount,
    validityDays: o.plan.validityDays,
    esimId: o.esim?.id ?? null,
    failureReason: o.failureReason,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/**
 * Create an order (checkout). Idempotent via client-supplied idempotency key.
 * If the key already exists, the existing order is returned.
 */
export async function createOrder(input: {
  userId: string;
  planId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<OrderSnapshot> {
  // Idempotency: return existing order for this key.
  const existing = await db.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { plan: true, esim: true } });
  if (existing) {
    return toSnapshot(existing);
  }

  const plan = await getCanonicalPlan(input.planId);
  if (!plan) throw new AppError("not_found", "Plan not found", 404, "This plan is no longer available.");
  if (plan.status !== "active") throw new AppError("conflict", "Plan inactive", 409, "This plan is no longer available.");

  const planSnapshot = JSON.stringify({
    id: plan.id,
    name: plan.name,
    country: plan.country,
    countryCode: plan.countryCode,
    dataAmountMB: plan.dataAmountMB,
    validityDays: plan.validityDays,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    networks: plan.networks,
    speed: plan.speed,
  });

  const order = await db.order.create({
    data: {
      userId: input.userId,
      planId: input.planId,
      status: "CHECKOUT_CREATED",
      amount: plan.priceMinor,
      currency: plan.currency,
      paymentStatus: "pending",
      idempotencyKey: input.idempotencyKey,
      planSnapshot,
    },
    include: { plan: true, esim: true },
  });

  await audit({ userId: input.userId, orderId: order.id, action: "order.created", entity: "order", entityId: order.id, ip: input.ip });
  logger.info("order.created", { orderId: order.id, userId: input.userId, planId: input.planId });
  return toSnapshot(order);
}

/**
 * Initiate payment for an order. Creates a payment intent with the provider.
 * Idempotent: re-calling with the same order returns the existing intent.
 */
export async function initiatePayment(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{
  orderId: string;
  status: OrderStatus;
  paymentReference: string;
  paymentStatus: string;
  clientSecret?: string;
}> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, include: { plan: true } });
  if (!order || order.userId !== input.userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");

  // Already paid? Short-circuit.
  if (order.paymentStatus === "succeeded") {
    return { orderId: order.id, status: order.status as OrderStatus, paymentReference: order.paymentReference ?? "", paymentStatus: "succeeded" };
  }

  assertTransition(order.status as OrderStatus, "PAYMENT_PENDING");

  const paymentProvider = getPaymentProvider();
  const intent = await paymentProvider.createPaymentIntent({
    amountMinor: order.amount,
    currency: order.currency as Currency,
    description: `eSIM ${order.plan.name}`,
    idempotencyKey: input.idempotencyKey,
    metadata: { orderId: order.id, userId: input.userId },
  });

  // Record the payment row (idempotent on idempotencyKey constraint).
  let payment = await db.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (!payment) {
    payment = await db.payment.create({
      data: {
        userId: input.userId,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        status: "pending",
        provider: paymentProvider.id,
        providerReference: intent.providerReference,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      status: "PAYMENT_PENDING",
      paymentStatus: "pending",
      paymentProvider: paymentProvider.id,
      paymentReference: intent.providerReference,
    },
  });

  await audit({ userId: input.userId, orderId: order.id, action: "payment.initiated", entity: "payment", entityId: payment.id, ip: input.ip });
  logger.info("payment.initiated", { orderId: order.id, paymentReference: intent.providerReference });
  return {
    orderId: order.id,
    status: "PAYMENT_PENDING",
    paymentReference: intent.providerReference,
    paymentStatus: "pending",
    clientSecret: intent.clientSecret,
  };
}

/**
 * Confirm payment — SERVER-SIDE verification. This is the single trusted path.
 * After verification, kicks off provisioning.
 *
 * For the mock provider, the client calls /api/payments/confirm which calls
 * mockPaymentProvider.confirmIntent() first (simulating the provider's own
 * confirmation), then this method verifies.
 */
export async function confirmAndProvision(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{ status: OrderStatus; paymentStatus: string; esimId: string | null }> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, include: { plan: true, esim: true } });
  if (!order || order.userId !== input.userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");

  // Already completed? Idempotent return.
  if (order.status === "COMPLETED" && order.esim) {
    return { status: "COMPLETED", paymentStatus: "succeeded", esimId: order.esim.id };
  }

  // Already failed payment? Reject.
  if (order.paymentStatus === "failed") {
    return { status: order.status as OrderStatus, paymentStatus: "failed", esimId: null };
  }

  if (!order.paymentReference) throw new AppError("conflict", "No payment reference", 409, "Payment has not been initiated.");

  // --- SERVER-SIDE payment verification (never trust the client) ---
  const paymentProvider = getPaymentProvider();
  const verification = await paymentProvider.verifyPayment({
    providerReference: order.paymentReference,
    idempotencyKey: input.idempotencyKey,
  });

  if (verification.status === "failed") {
    await db.order.update({
      where: { id: order.id },
      data: { status: "PAYMENT_FAILED", paymentStatus: "failed", failureReason: "Payment verification failed" },
    });
    await db.payment.updateMany({ where: { orderId: order.id, providerReference: order.paymentReference }, data: { status: "failed" } });
    await audit({ userId: input.userId, orderId: order.id, action: "payment.failed", entity: "order", entityId: order.id, ip: input.ip });
    logger.warn("payment.failed", { orderId: order.id });
    return { status: "PAYMENT_FAILED", paymentStatus: "failed", esimId: null };
  }

  if (verification.status === "pending") {
    return { status: "PAYMENT_PENDING", paymentStatus: "pending", esimId: null };
  }

  // verification.status === "succeeded"
  // Only transition to PAYMENT_CONFIRMED if we haven't already passed it. This
  // allows retrying provisioning for a PROVISIONING_FAILED order without
  // re-running the (illegal) PAYMENT_CONFIRMED transition.
  const alreadyPaid = order.paymentStatus === "succeeded" &&
    ["PAYMENT_CONFIRMED", "ESIM_PROVISIONING", "ESIM_PROVISIONED", "PROVISIONING_FAILED"].includes(order.status);
  if (!alreadyPaid) {
    assertTransition(order.status as OrderStatus, "PAYMENT_CONFIRMED");
    await db.order.update({
      where: { id: order.id },
      data: { status: "PAYMENT_CONFIRMED", paymentStatus: "succeeded" },
    });
    await db.payment.updateMany({ where: { orderId: order.id, providerReference: order.paymentReference }, data: { status: "succeeded" } });
    await audit({ userId: input.userId, orderId: order.id, action: "payment.confirmed", entity: "order", entityId: order.id, ip: input.ip });
    logger.info("payment.confirmed", { orderId: order.id });
  }

  // --- Provisioning ---
  try {
    const esimId = await provisionOrderESIM({ orderId: order.id, userId: input.userId, idempotencyKey: `prov_${input.idempotencyKey}`, ip: input.ip });
    return { status: "COMPLETED", paymentStatus: "succeeded", esimId };
  } catch (err) {
    logger.error("provisioning.failed", { orderId: order.id, error: err instanceof Error ? err.message : String(err) });
    await db.order.update({
      where: { id: order.id },
      data: { status: "PROVISIONING_FAILED", failureReason: err instanceof Error ? err.message : "Provisioning failed" },
    });
    await audit({ userId: input.userId, orderId: order.id, action: "provisioning.failed", entity: "order", entityId: order.id, ip: input.ip });
    throw classifyProviderError("activating your eSIM", err);
  }
}

/**
 * Provision (or re-provision after a failure) an eSIM for an order.
 * Idempotent: an order can only provision once (Order.esim is 1:1 unique).
 */
export async function provisionOrderESIM(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<string> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, include: { plan: true, esim: true } });
  if (!order || order.userId !== input.userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");

  // Rule 3: an order can only provision once.
  if (order.esim) {
    logger.info("provision.idempotent_skip", { orderId: order.id, esimId: order.esim.id });
    return order.esim.id;
  }

  if (order.status === "PROVISIONING_FAILED" || order.status === "PAYMENT_CONFIRMED") {
    assertTransition(order.status as OrderStatus, "ESIM_PROVISIONING");
  } else if (order.status !== "ESIM_PROVISIONING") {
    throw new AppError("conflict", `Cannot provision from ${order.status}`, 409, "This order is not ready for provisioning.");
  }

  await db.order.update({ where: { id: order.id }, data: { status: "ESIM_PROVISIONING" } });

  const provider = getESIMProvider();

  // Create provider order (idempotent). We use a stable key derived from orderId.
  const orderKey = `po_${order.id}`;
  const { providerOrderId } = await provider.createOrder({
    providerPlanId: order.plan.providerPlanId,
    idempotencyKey: orderKey,
  });

  // Provision eSIM (idempotent).
  const result: ProvisioningResult = await provider.provisionESIM({
    providerOrderId,
    idempotencyKey: input.idempotencyKey,
  });

  // Build LPA QR payload: LPA:1<smdpAddress>&<activationCode>
  const qrPayload = `LPA:1${result.smdpAddress}&${result.activationCode}`;
  const qrCode = await QRCode.toDataURL(qrPayload, { margin: 2, width: 480 });

  // Persist the eSIM (1:1 with order via unique orderId).
  const esim = await db.esim.create({
    data: {
      userId: order.userId,
      orderId: order.id,
      provider: provider.id,
      providerESIMId: result.providerESIMId,
      iccid: result.iccid,
      smdpAddress: result.smdpAddress,
      activationCode: result.activationCode,
      matchId: result.matchId ?? null,
      qrCode,
      status: "active",
      dataAmount: result.dataAmountMB,
      dataRemaining: result.dataAmountMB,
      validityDays: result.validityDays,
      expiresAt: new Date(result.expiresAt),
    },
  });

  await db.order.update({
    where: { id: order.id },
    data: { status: "COMPLETED", providerOrderId, esim: { connect: { id: esim.id } } },
  });

  // Record initial usage sample.
  await db.usage.create({
    data: { esimId: esim.id, dataUsed: 0, dataRemaining: result.dataAmountMB, source: "provider" },
  });

  await audit({ userId: input.userId, orderId: order.id, action: "esim.provisioned", entity: "esim", entityId: esim.id, ip: input.ip });
  logger.info("esim.provisioned", { orderId: order.id, esimId: esim.id, iccid: result.iccid });
  return esim.id;
}

/** Get an order snapshot. */
export async function getOrder(orderId: string, userId: string): Promise<OrderSnapshot> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { plan: true, esim: true } });
  if (!order || order.userId !== userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");
  return toSnapshot(order);
}

/** List a user's orders. */
export async function listUserOrders(userId: string): Promise<OrderSnapshot[]> {
  const orders = await db.order.findMany({ where: { userId }, include: { plan: true, esim: true }, orderBy: { createdAt: "desc" } });
  return orders.map(toSnapshot);
}

/** Retry provisioning for a PROVISIONING_FAILED order. */
export async function retryProvisioning(orderId: string, userId: string, ip?: string): Promise<{ status: OrderStatus; esimId: string | null }> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { esim: true } });
  if (!order || order.userId !== userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");
  if (order.esim) return { status: "COMPLETED", esimId: order.esim.id };
  if (order.paymentStatus !== "succeeded") throw new AppError("conflict", "Payment not confirmed", 409, "Payment must be confirmed before retrying.");
  const esimId = await provisionOrderESIM({ orderId, userId, idempotencyKey: `prov_retry_${order.id}_${Date.now()}`, ip });
  return { status: "COMPLETED", esimId };
}
