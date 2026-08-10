import { NextRequest } from "next/server";
import { getPaymentProvider } from "@/lib/payments";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";
import { logger } from "@/lib/logger";

/**
 * Payment provider webhook. Idempotent via WebhookEvent dedup.
 * Verifies signature, then reconciles payment status server-side.
 */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature") ?? req.headers.get("x-webhook-signature");
    const provider = getPaymentProvider();
    const event = await provider.verifyWebhook({ signature, rawBody });
    if (!event) {
      logger.warn("payment.webhook.invalid_signature");
      return json({ error: "invalid signature" }, 401);
    }

    // Idempotency: dedup by (provider, externalId).
    const existing = await db.webhookEvent.findUnique({
      where: { provider_externalId: { provider: provider.id, externalId: event.externalId } },
    });
    if (existing?.processed) {
      return json({ ok: true, deduplicated: true });
    }

    const log = await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: provider.id, externalId: event.externalId } },
      create: { provider: provider.id, eventType: event.eventType, externalId: event.externalId, payload: rawBody, processed: false },
      update: {},
    });

    // Reconcile the referenced payment/order.
    if (event.data.providerReference) {
      const payment = await db.payment.findFirst({ where: { providerReference: event.data.providerReference } });
      if (payment) {
        const status = event.data.status ?? "succeeded";
        await db.payment.update({ where: { id: payment.id }, data: { status } });
        if (status === "succeeded") {
          // Order state machine update; provisioning handled by confirm flow / retry job.
          await db.order.updateMany({
            where: { id: payment.orderId, paymentStatus: { not: "succeeded" } },
            data: { paymentStatus: "succeeded" },
          });
          logger.info("payment.webhook.reconciled", { orderId: payment.orderId, status });
        }
      }
    }

    await db.webhookEvent.update({ where: { id: log.id }, data: { processed: true, processedAt: new Date() } });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
