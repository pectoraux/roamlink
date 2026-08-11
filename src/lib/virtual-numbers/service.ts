/**
 * Virtual number service — orchestrates purchase, provisioning, messaging, calls.
 *
 * Reuses the existing order + payment infrastructure. A virtual number purchase
 * creates an Order (productType = "virtual_number"), goes through the same
 * payment verification, then provisions the number via the VN provider.
 */

import { db } from "@/lib/db";
import { getVNProvider } from ".";
import { getPaymentProvider, mockPaymentProvider } from "@/lib/payments";
import { generateIdempotencyKey, audit } from "@/lib/orders/idempotency";
import { AppError, classifyProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertNumberTransition } from "./state-machine";
import type { NumberStatus } from "./state-machine";
import type { ProviderNumber } from "./provider";
import type { Currency } from "@/lib/money";

/** Search available numbers. */
export async function searchNumbers(params: {
  countryCode?: string;
  region?: string;
  smsRequired?: boolean;
  voiceRequired?: boolean;
  mmsRequired?: boolean;
  limit?: number;
}) {
  const provider = getVNProvider();
  return provider.searchNumbers(params);
}

/** Get the number catalog (countries + capabilities) for UI. */
export async function getNumberCountries() {
  // The mock provider's catalog IS the source of truth in dev.
  // In production, this would come from the provider's available countries API.
  const provider = getVNProvider();
  const allNumbers = await provider.searchNumbers({ limit: 200 });
  const byCountry = new Map<string, { country: string; countryCode: string; sms: boolean; voice: boolean; mms: boolean; count: number; regions: Set<string> }>();
  for (const n of allNumbers) {
    const existing = byCountry.get(n.countryCode);
    if (existing) {
      existing.count++;
      existing.sms = existing.sms || n.smsEnabled;
      existing.voice = existing.voice || n.voiceEnabled;
      existing.mms = existing.mms || n.mmsEnabled;
      if (n.region) existing.regions.add(n.region);
    } else {
      byCountry.set(n.countryCode, {
        country: n.country,
        countryCode: n.countryCode,
        sms: n.smsEnabled,
        voice: n.voiceEnabled,
        mms: n.mmsEnabled,
        count: 1,
        regions: new Set(n.region ? [n.region] : []),
      });
    }
  }
  return Array.from(byCountry.values()).map((c) => ({ ...c, regions: Array.from(c.regions) }));
}

/**
 * Purchase a virtual number. Reuses the existing order + payment infrastructure.
 * Idempotent via idempotencyKey.
 */
export async function purchaseNumber(input: {
  userId: string;
  providerNumberId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{ orderId: string; virtualNumberId: string; status: string }> {
  const provider = getVNProvider();
  const providerNumber = await provider.getNumber(input.providerNumberId);
  if (!providerNumber) throw new AppError("not_found", "Number not found", 404, "This number is no longer available.");

  // Check if number is already owned by this user
  const existing = await db.virtualNumber.findUnique({ where: { e164: providerNumber.e164 } });
  if (existing && existing.userId === input.userId && existing.status === "active") {
    return { orderId: existing.orderId ?? "", virtualNumberId: existing.id, status: "active" };
  }
  if (existing && existing.status === "active") {
    throw new AppError("conflict", "Number taken", 409, "This number is already in use.");
  }

  // Create an order (reuse existing Order model, productType = virtual_number)
  const sellingPrice = (providerNumber as any).sellingPriceMinor ?? Math.round(providerNumber.monthlyCostMinor * 1.65);
  const order = await db.order.create({
    data: {
      userId: input.userId,
      planId: null, // no Plan row for virtual numbers
      productType: "virtual_number",
      status: "CHECKOUT_CREATED",
      amount: sellingPrice,
      currency: providerNumber.currency,
      paymentStatus: "pending",
      idempotencyKey: input.idempotencyKey,
      planSnapshot: JSON.stringify({ type: "virtual_number", e164: providerNumber.e164, country: providerNumber.country, providerNumberId: providerNumber.providerNumberId, sellingPrice }),
    },
  });

  await audit({ userId: input.userId, orderId: order.id, action: "vn.order_created", entity: "order", entityId: order.id, ip: input.ip });
  logger.info("vn.order_created", { orderId: order.id, userId: input.userId, e164: providerNumber.e164 });

  // For mock provider: simulate payment + provision immediately.
  // In production, this would go through the checkout → payment → confirm flow.
  const paymentProvider = getPaymentProvider();
  const payKey = `vn_pay_${order.id}`;
  const intent = await paymentProvider.createPaymentIntent({
    amountMinor: sellingPrice,
    currency: providerNumber.currency as Currency,
    description: `Virtual Number ${providerNumber.e164}`,
    idempotencyKey: payKey,
    metadata: { orderId: order.id, userId: input.userId },
  });

  await db.order.update({
    where: { id: order.id },
    data: { status: "PAYMENT_PENDING", paymentProvider: paymentProvider.id, paymentReference: intent.providerReference },
  });

  // Mock: confirm payment immediately
  if (paymentProvider.isMock) {
    mockPaymentProvider.confirmIntent(intent.providerReference);
  }

  const verification = await paymentProvider.verifyPayment({
    providerReference: intent.providerReference,
    idempotencyKey: `vn_verify_${order.id}`,
  });

  if (verification.status !== "succeeded") {
    await db.order.update({ where: { id: order.id }, data: { status: "PAYMENT_FAILED", paymentStatus: "failed" } });
    throw new AppError("payment", "Payment failed", 402, "We couldn't process your payment. Please try again.");
  }

  await db.order.update({ where: { id: order.id }, data: { status: "PAYMENT_CONFIRMED", paymentStatus: "succeeded" } });
  await db.payment.create({
    data: {
      userId: input.userId,
      orderId: order.id,
      amount: sellingPrice,
      currency: providerNumber.currency,
      status: "succeeded",
      provider: paymentProvider.id,
      providerReference: intent.providerReference,
      idempotencyKey: payKey,
    },
  });

  // Provision the number
  try {
    const purchased = await provider.purchaseNumber({
      providerNumberId: providerNumber.providerNumberId,
      idempotencyKey: `vn_prov_${order.id}`,
    });

    const sellingPriceFinal = (providerNumber as any).sellingPriceMinor ?? Math.round(providerNumber.monthlyCostMinor * 1.65);

    const vn = await db.virtualNumber.create({
      data: {
        e164: purchased.e164,
        country: purchased.country,
        countryCode: purchased.countryCode,
        region: purchased.region ?? null,
        city: purchased.city ?? null,
        numberType: purchased.numberType,
        smsEnabled: purchased.smsEnabled,
        mmsEnabled: purchased.mmsEnabled,
        voiceEnabled: purchased.voiceEnabled,
        status: "active",
        provider: provider.id,
        providerNumberId: purchased.providerNumberId,
        providerCost: purchased.monthlyCostMinor,
        sellingPrice: sellingPriceFinal,
        currency: purchased.currency,
        userId: input.userId,
        orderId: order.id,
        activatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });

    // Create subscription
    await db.numberSubscription.create({
      data: {
        virtualNumberId: vn.id,
        userId: input.userId,
        status: "active",
        billingCycle: "monthly",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        idempotencyKey: `vn_sub_${order.id}`,
      },
    });

    // Configure number (set webhook URLs)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://roamlink-chi.vercel.app";
    await provider.configureNumber({
      providerNumberId: purchased.providerNumberId,
      smsWebhookUrl: `${appUrl}/api/webhooks/virtual-numbers`,
      voiceWebhookUrl: `${appUrl}/api/webhooks/virtual-numbers`,
    });

    await db.order.update({ where: { id: order.id }, data: { status: "COMPLETED" } });
    await audit({ userId: input.userId, orderId: order.id, action: "vn.provisioned", entity: "virtual_number", entityId: vn.id, ip: input.ip });
    logger.info("vn.provisioned", { orderId: order.id, vnId: vn.id, e164: purchased.e164 });

    return { orderId: order.id, virtualNumberId: vn.id, status: "active" };
  } catch (err) {
    logger.error("vn.provisioning_failed", { orderId: order.id, error: err instanceof Error ? err.message : String(err) });
    await db.order.update({ where: { id: order.id }, data: { status: "PROVISIONING_FAILED", failureReason: err instanceof Error ? err.message : "Provisioning failed" } });
    throw classifyProviderError("provisioning your number", err);
  }
}

/** List a user's virtual numbers. */
export async function listUserNumbers(userId: string) {
  return db.virtualNumber.findMany({
    where: { userId, status: { not: "released" } },
    include: { subscriptions: true },
    orderBy: { createdAt: "desc" },
  });
}

/** Get a single virtual number with ownership check. */
export async function getUserNumber(userId: string, vnId: string) {
  const vn = await db.virtualNumber.findUnique({
    where: { id: vnId },
    include: { subscriptions: true, messages: { orderBy: { createdAt: "desc" }, take: 50 }, calls: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!vn || vn.userId !== userId) throw new AppError("not_found", "Number not found", 404, "Number not found.");
  return vn;
}

/** Release a number. */
export async function releaseNumber(userId: string, vnId: string) {
  const vn = await getUserNumber(userId, vnId);
  if (vn.status === "released") throw new AppError("conflict", "Already released", 409, "This number has already been released.");

  const provider = getVNProvider();
  if (vn.providerNumberId) {
    try { await provider.releaseNumber(vn.providerNumberId); } catch { /* best effort */ }
  }

  await db.virtualNumber.update({
    where: { id: vnId },
    data: { status: "released", releasedAt: new Date() },
  });
  await db.numberSubscription.updateMany({
    where: { virtualNumberId: vnId, status: "active" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });

  await audit({ userId, action: "vn.released", entity: "virtual_number", entityId: vnId });
  logger.info("vn.released", { vnId, e164: vn.e164 });
}

/** Send an SMS from a user's number. */
export async function sendSMS(userId: string, vnId: string, to: string, body: string) {
  const vn = await getUserNumber(userId, vnId);
  if (!vn.smsEnabled) throw new AppError("conflict", "SMS not supported", 409, "This number does not support SMS.");
  if (vn.status !== "active") throw new AppError("conflict", "Number not active", 409, "This number is not active.");

  const provider = getVNProvider();
  const msg = await provider.sendSMS({ providerNumberId: vn.providerNumberId!, to, body });

  const message = await db.message.create({
    data: {
      virtualNumberId: vnId,
      direction: "outbound",
      fromNumber: vn.e164,
      toNumber: to,
      body,
      status: msg.status,
      providerMessageId: msg.providerMessageId,
      segments: msg.segments,
    },
  });

  await audit({ userId, action: "vn.sms_sent", entity: "virtual_number", entityId: vnId, detail: { to, messageId: message.id } });
  return message;
}

/** Get messages for a number. */
export async function getMessages(userId: string, vnId: string, limit = 50) {
  await getUserNumber(userId, vnId); // ownership check
  return db.message.findMany({
    where: { virtualNumberId: vnId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Process an inbound SMS from a provider webhook. */
export async function processInboundMessage(input: {
  providerNumberId: string;
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
}) {
  const vn = await db.virtualNumber.findFirst({ where: { providerNumberId: input.providerNumberId } });
  if (!vn) {
    logger.warn("vn.inbound_unknown_number", { providerNumberId: input.providerNumberId });
    return null;
  }

  // Idempotency: check if message already exists
  const existing = await db.message.findFirst({ where: { providerMessageId: input.providerMessageId } });
  if (existing) return existing;

  const message = await db.message.create({
    data: {
      virtualNumberId: vn.id,
      direction: "inbound",
      fromNumber: input.from,
      toNumber: input.to,
      body: input.body,
      status: "received",
      providerMessageId: input.providerMessageId,
    },
  });

  logger.info("vn.inbound_sms", { vnId: vn.id, from: input.from });
  return message;
}

/** Get calls for a number. */
export async function getCalls(userId: string, vnId: string, limit = 20) {
  await getUserNumber(userId, vnId);
  return db.call.findMany({
    where: { virtualNumberId: vnId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
