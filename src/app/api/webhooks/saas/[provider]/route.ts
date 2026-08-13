/**
 * SaaS Payment Webhook Handler (provider-scoped).
 *   POST /api/webhooks/saas/[provider] — receives payment provider webhooks.
 *
 * Phase 2B.3.4: The provider is part of the URL, not just the payload.
 * This ensures the invoice is looked up by (paymentProvider, providerReference)
 * — not just providerReference alone.
 *
 * Examples:
 *   POST /api/webhooks/saas/stripe
 *   POST /api/webhooks/saas/paystack
 *   POST /api/webhooks/saas/flutterwave
 *   POST /api/webhooks/saas/mock
 */

import { NextRequest, NextResponse } from "next/server";
import { getPaymentProviderByKey } from "@/lib/payments";
import { handleSaasPaymentWebhook } from "@/lib/tenant/saas-subscription";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerKey } = await params;

    // Resolve the provider by key — this also validates the provider is known
    let provider;
    try {
      provider = getPaymentProviderByKey(providerKey);
    } catch {
      return NextResponse.json({ error: `Unknown provider: ${providerKey}` }, { status: 400 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-signature") ?? req.headers.get("stripe-signature") ?? null;

    // Verify the webhook with the provider-specific implementation
    const event = await provider.verifyWebhook({ signature, rawBody });
    if (!event) {
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    // Extract payment reference and status
    const providerReference = event.data.providerReference;
    const status = event.data.status;

    if (!providerReference || !status) {
      logger.warn("saas.webhook_missing_data", { providerKey, externalId: event.externalId });
      return NextResponse.json({ ok: true }, 200);
    }

    // Handle with provider identity — the invoice is looked up by
    // (paymentProvider=providerKey, providerReference)
    const result = await handleSaasPaymentWebhook({
      providerKey,
      providerReference,
      status: status as "succeeded" | "failed" | "pending",
    });

    return NextResponse.json({ ok: true, handled: result.handled }, 200);
  } catch (err) {
    logger.error("saas.webhook_error", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
