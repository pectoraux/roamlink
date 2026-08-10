import { NextRequest } from "next/server";
import { getESIMProvider } from "@/lib/esim";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";
import { logger } from "@/lib/logger";

/**
 * eSIM provider webhook. Idempotent via WebhookEvent dedup.
 * Handles usage updates, status changes, expiration.
 */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature") ?? req.headers.get("x-webhook-signature");
    const provider = getESIMProvider();
    const event = await provider.verifyWebhook({ signature, rawBody });
    if (!event) {
      logger.warn("esim.webhook.invalid_signature");
      return json({ error: "invalid signature" }, 401);
    }

    // Idempotency dedup.
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

    // Apply the event to the eSIM.
    if (event.data.providerESIMId) {
      const esim = await db.esim.findFirst({ where: { providerESIMId: event.data.providerESIMId } });
      if (esim) {
        const update: Record<string, unknown> = {};
        if (event.data.dataRemainingMB != null) {
          update.dataRemaining = event.data.dataRemainingMB;
          if (event.data.dataRemainingMB <= 0) update.status = "exhausted";
        }
        if (event.data.status) update.status = event.data.status;
        if (event.data.expiresAt) update.expiresAt = new Date(event.data.expiresAt);
        if (Object.keys(update).length > 0) {
          await db.esim.update({ where: { id: esim.id }, data: update });
          if (event.data.dataRemainingMB != null) {
            await db.usage.create({
              data: {
                esimId: esim.id,
                dataUsed: Math.max(0, esim.dataAmount - event.data.dataRemainingMB),
                dataRemaining: event.data.dataRemainingMB,
                source: "provider",
              },
            });
          }
        }
        logger.info("esim.webhook.applied", { esimId: esim.id, eventType: event.eventType });
      }
    }

    await db.webhookEvent.update({ where: { id: log.id }, data: { processed: true, processedAt: new Date() } });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
