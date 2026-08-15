/**
 * Phase 5.1 — Commerce Payment Webhook Handler
 * POST /api/webhooks/commerce/[provider]
 *
 * Receives payment provider webhooks for commerce orders. Verifies the
 * webhook signature, processes the payment idempotently, marks the order
 * paid, and calls fulfillOrder() to create the entitlement + provision
 * the resource.
 *
 * Idempotency: the WebhookEvent model ensures each webhook is processed
 * exactly once. If a webhook with the same (provider, externalId) has
 * already been processed, it's skipped.
 *
 * Flow:
 *   1. Verify webhook signature (provider-specific)
 *   2. Deduplicate via WebhookEvent (provider, externalId)
 *   3. Find the order by providerReference
 *   4. If payment succeeded and order is pending → mark paid + fulfillOrder()
 *   5. If payment failed → mark order failed
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPaymentProviderByKey } from "@/lib/payments";
import { fulfillOrder } from "@/lib/commerce/fulfillment";
import { logger } from "@/lib/logger";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerKey } = await params;
  const rawBody = await req.text();

  // Get the signature header (Paystack uses x-paystack-signature, Stripe uses stripe-signature)
  const signature =
    req.headers.get("x-paystack-signature") ||
    req.headers.get("stripe-signature") ||
    null;

  let provider;
  try {
    provider = getPaymentProviderByKey(providerKey);
  } catch {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  // Step 1: Verify the webhook signature
  let webhookEvent;
  try {
    webhookEvent = await provider.verifyWebhook({ signature, rawBody });
  } catch (err) {
    logger.error("commerce.webhook_verification_failed", {
      provider: providerKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Webhook verification failed" }, { status: 400 });
  }

  if (!webhookEvent) {
    logger.warn("commerce.webhook_invalid_signature", { provider: providerKey });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Step 2: Deduplicate via WebhookEvent
  const existingEvent = await db.webhookEvent.findUnique({
    where: {
      provider_externalId: {
        provider: providerKey,
        externalId: webhookEvent.externalId || webhookEvent.data.providerReference || "unknown",
      },
    },
  });

  if (existingEvent?.processed) {
    logger.info("commerce.webhook_already_processed", {
      provider: providerKey,
      externalId: existingEvent.externalId,
    });
    return NextResponse.json({ status: "already_processed" });
  }

  // Record the webhook event (or update if it exists but wasn't processed)
  const event = await db.webhookEvent.upsert({
    where: {
      provider_externalId: {
        provider: providerKey,
        externalId: webhookEvent.externalId || webhookEvent.data.providerReference || "unknown",
      },
    },
    create: {
      provider: providerKey,
      eventType: webhookEvent.eventType,
      externalId: webhookEvent.externalId || webhookEvent.data.providerReference || "unknown",
      payload: JSON.stringify(webhookEvent.raw),
      processed: false,
    },
    update: {
      eventType: webhookEvent.eventType,
      payload: JSON.stringify(webhookEvent.raw),
    },
  });

  // Step 3: Find the order by providerReference
  const providerReference = webhookEvent.data.providerReference;
  if (!providerReference) {
    logger.warn("commerce.webhook_no_reference", { provider: providerKey, eventId: event.id });
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true, error: "No providerReference in webhook", processedAt: new Date() },
    });
    return NextResponse.json({ status: "no_reference" });
  }

  const order = await db.customerOrder.findFirst({
    where: { paymentRef: providerReference },
  });

  if (!order) {
    logger.warn("commerce.webhook_order_not_found", { providerReference, provider: providerKey });
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true, error: "Order not found", processedAt: new Date() },
    });
    return NextResponse.json({ status: "order_not_found" });
  }

  // Step 4: Process based on payment status
  const paymentStatus = webhookEvent.data.status;

  try {
    if (paymentStatus === "succeeded") {
      // Only fulfill if the order is still pending (idempotency)
      if (order.status === "pending") {
        await db.customerOrder.update({
          where: { id: order.id },
          data: { status: "paid" },
        });

        // Update the Payment record
        await db.payment.updateMany({
          where: { orderId: order.id, status: "pending" },
          data: { status: "succeeded" },
        });

        logger.info("commerce.webhook_payment_succeeded", {
          orderId: order.id,
          providerReference,
        });

        // Fulfill the order (creates entitlement + provisions resource + posts ledger)
        const result = await fulfillOrder(order.id);

        logger.info("commerce.webhook_fulfilled", {
          orderId: order.id,
          status: result.status,
        });
      } else {
        logger.info("commerce.webhook_order_already_processed", {
          orderId: order.id,
          status: order.status,
        });
      }
    } else if (paymentStatus === "failed") {
      if (order.status === "pending") {
        await db.customerOrder.update({
          where: { id: order.id },
          data: { status: "failed" },
        });

        await db.payment.updateMany({
          where: { orderId: order.id, status: "pending" },
          data: { status: "failed" },
        });

        logger.warn("commerce.webhook_payment_failed", {
          orderId: order.id,
          providerReference,
        });
      }
    }

    // Mark the webhook as processed
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true, processedAt: new Date() },
    });

    return NextResponse.json({ status: "processed" });
  } catch (err) {
    logger.error("commerce.webhook_processing_failed", {
      eventId: event.id,
      orderId: order.id,
      error: err instanceof Error ? err.message : String(err),
    });

    // Mark the webhook as failed (will be retried by the provider)
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true, error: err instanceof Error ? err.message : String(err), processedAt: new Date() },
    });

    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
