/**
 * ESIM Fulfillment Persistence — stores the result of an eSIM fulfillment
 * (from the FulfillmentAdapter) onto the order as an `Esim` row.
 *
 * This handler owns the eSIM-specific persistence that previously lived
 * inline in `provisionOrderESIM`. By isolating it here, the orchestrator
 * can support new product types (Wi-Fi, VN, ...) without modification —
 * each product type registers its own persistence handler.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import type {
  FulfillmentContext,
  FulfillmentPersistenceHandler,
  FulfillmentResult,
} from "./adapter";
import QRCode from "qrcode";

/**
 * Persist an eSIM fulfillment result. The order must already have a connected
 * Plan (so we can derive data allowance / validity if the adapter omits them).
 */
async function persistEsim(input: {
  context: FulfillmentContext;
  result: FulfillmentResult;
  providerOrderId: string;
}): Promise<{ entityId: string }> {
  const { context, result, providerOrderId } = input;
  const order = await db.order.findUnique({
    where: { id: context.orderId },
    include: { esim: true, plan: true },
  });
  if (!order) {
    throw new AppError("not_found", `Order ${context.orderId} not found`, 404, "Order not found.");
  }

  // Rule 3 (existing hardening): an order can only provision once.
  if (order.esim) {
    logger.info("fulfillment.esim.idempotent_skip", {
      orderId: order.id,
      esimId: order.esim.id,
    });
    return { entityId: order.esim.id };
  }

  const meta = result.metadata;
  const iccid = String(meta.iccid ?? "");
  const smdpAddress = String(meta.smdpAddress ?? "");
  const activationCode = String(meta.activationCode ?? "");
  const matchId = meta.matchId ? String(meta.matchId) : null;
  const providerESIMId = String(meta.providerESIMId ?? result.externalReference);
  // Phase 2E.2: Use the immutable order snapshot for data/validity, NOT the
  // live Plan. The snapshot was captured at checkout and contains all
  // product-defining facts. The Plan may be mutated after checkout.
  const snapshot = order.planSnapshot ? JSON.parse(order.planSnapshot) : {};
  const dataAmount = Number(meta.dataAmountMB ?? snapshot.dataAmountMB ?? 0);
  const validityDays = Number(meta.validityDays ?? snapshot.validityDays ?? 0);
  const expiresAt = result.expiresAt ? new Date(result.expiresAt) : new Date(Date.now() + validityDays * 86400_000);

  // Build LPA QR payload: LPA:1<smdpAddress>&<activationCode>
  const qrPayload = `LPA:1${smdpAddress}&${activationCode}`;
  const qrCode = await QRCode.toDataURL(qrPayload, { margin: 2, width: 480 });

  const esim = await db.esim.create({
    data: {
      userId: order.userId,
      orderId: order.id,
      provider: context.providerKey,
      providerESIMId,
      iccid,
      smdpAddress,
      activationCode,
      matchId,
      qrCode,
      status: "active",
      dataAmount,
      dataRemaining: dataAmount,
      validityDays,
      expiresAt,
    },
  });

  // Record initial usage sample.
  await db.usage.create({
    data: { esimId: esim.id, dataUsed: 0, dataRemaining: dataAmount, source: "provider" },
  });

  // Update the order with the fulfillment entity reference.
  await db.order.update({
    where: { id: order.id },
    data: {
      providerOrderId,
      fulfillmentEntityId: esim.id,
      fulfillmentExternalReference: providerESIMId,
    },
  });

  logger.info("fulfillment.esim.persisted", {
    orderId: order.id,
    esimId: esim.id,
    iccid,
  });
  return { entityId: esim.id };
}

export const ESIMFulfillmentPersistence: FulfillmentPersistenceHandler = {
  productType: "ESIM",
  persist: persistEsim,
};
