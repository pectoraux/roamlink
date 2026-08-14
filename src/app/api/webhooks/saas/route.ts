/**
 * SaaS Payment Webhook Handler (DEPRECATED).
 *   POST /api/webhooks/saas — DEPRECATED. Use /api/webhooks/saas/[provider] instead.
 *
 * Phase 2B.3.5: This route is deprecated and returns 410 Gone.
 * Financial webhooks MUST use the provider-scoped route:
 *   POST /api/webhooks/saas/stripe
 *   POST /api/webhooks/saas/paystack
 *   POST /api/webhooks/saas/flutterwave
 *   POST /api/webhooks/saas/mock
 *
 * The legacy route used the global configured provider, which is unsafe
 * in a multi-provider architecture — an incoming webhook could be
 * associated with the wrong provider.
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export async function POST() {
  logger.warn("saas.legacy_webhook_rejected", { message: "Use /api/webhooks/saas/[provider] instead" });
  return NextResponse.json(
    { error: "This endpoint is deprecated. Use /api/webhooks/saas/[provider] instead." },
    { status: 410 },
  );
}
