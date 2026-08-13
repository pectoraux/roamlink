/**
 * SaaS Payment Webhook Handler.
 *   POST /api/webhooks/saas — receives payment provider webhooks for SaaS subscriptions.
 *
 * Idempotent: if the invoice is already paid, returns 200 without re-charging.
 * Uses the existing payment provider's verifyWebhook for signature verification.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPaymentProvider } from "@/lib/payments";
import { handleSaasPaymentWebhook } from "@/lib/tenant/saas-subscription";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const provider = getPaymentProvider();
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature") ?? req.headers.get("stripe-signature") ?? null;

    const event = await provider.verifyWebhook({ signature, rawBody });
    if (!event) {
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    // Extract the payment reference and status from the webhook event
    const providerReference = event.data.providerReference;
    const status = event.data.status;

    if (!providerReference || !status) {
      logger.warn("saas.webhook_missing_data", { externalId: event.externalId });
      return NextResponse.json({ ok: true }, 200);
    }

    const result = await handleSaasPaymentWebhook({
      providerReference,
      status: status as "succeeded" | "failed" | "pending",
    });

    return NextResponse.json({ ok: true, handled: result.handled }, 200);
  } catch (err) {
    logger.error("saas.webhook_error", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
