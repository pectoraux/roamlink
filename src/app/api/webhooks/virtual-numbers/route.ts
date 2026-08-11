import { NextRequest } from "next/server";
import { getVNProvider } from "@/lib/virtual-numbers";
import { processInboundMessage } from "@/lib/virtual-numbers/service";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";
import { logger } from "@/lib/logger";

/** POST /api/webhooks/virtual-numbers — inbound telecom webhook (SMS, voice). */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature") ?? req.headers.get("x-webhook-signature");
    const provider = getVNProvider();
    const event = await provider.verifyWebhook({ signature, rawBody });
    if (!event) {
      logger.warn("vn.webhook.invalid_signature");
      return json({ error: "invalid signature" }, 401);
    }

    // Idempotency: dedup by (provider, externalId)
    const existing = await db.webhookEvent.findUnique({
      where: { provider_externalId: { provider: provider.id, externalId: event.externalId } },
    });
    if (existing?.processed) return json({ ok: true, deduplicated: true });

    const log = await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: provider.id, externalId: event.externalId } },
      create: { provider: provider.id, eventType: event.eventType, externalId: event.externalId, payload: rawBody, processed: false },
      update: {},
    });

    // Process SMS events
    if (event.data.message && event.eventType.includes("sms")) {
      const msg = event.data.message;
      if (msg.from && msg.to && msg.body && msg.providerMessageId) {
        await processInboundMessage({
          providerNumberId: event.data.providerNumberId ?? "",
          from: msg.from,
          to: msg.to,
          body: msg.body,
          providerMessageId: msg.providerMessageId,
        });
      }
    }

    // Process call events
    if (event.data.call && event.eventType.includes("call")) {
      const call = event.data.call;
      const vn = event.data.providerNumberId
        ? await db.virtualNumber.findFirst({ where: { providerNumberId: event.data.providerNumberId } })
        : null;
      if (vn && call.from && call.to) {
        await db.call.create({
          data: {
            virtualNumberId: vn.id,
            direction: call.direction ?? "inbound",
            fromNumber: call.from,
            toNumber: call.to,
            status: call.status ?? "completed",
            durationSeconds: call.durationSeconds ?? 0,
            providerCallId: call.providerCallId,
          },
        }).catch(() => {}); // best effort — may already exist
      }
    }

    await db.webhookEvent.update({ where: { id: log.id }, data: { processed: true, processedAt: new Date() } });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
