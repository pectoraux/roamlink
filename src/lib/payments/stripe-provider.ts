/**
 * Stripe payment adapter.
 *
 * Stripe flow (test mode):
 *   1. Create PaymentIntent → returns `client_secret` + `id` (pi_...)
 *   2. Client confirms with Stripe.js (card element) using client_secret
 *   3. Server verifies via GET /payment_intents/:id
 *   4. Webhook → /webhooks (signed with STRIPE_SECRET_KEY via Stripe-Signature)
 *
 * Docs: https://stripe.com/docs/api
 *
 * Credentials from STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY.
 */

import type {
  PaymentProvider,
  PaymentIntentResult,
  PaymentVerification,
  PaymentWebhookEvent,
} from "./provider";
import type { Currency } from "@/lib/money";
import { logger } from "@/lib/logger";
import { safeEqual } from "@/lib/security";
import { createHmac } from "crypto";

const API_BASE = "https://api.stripe.com/v1";

export class StripeProvider implements PaymentProvider {
  readonly id = "stripe";
  readonly label = "Stripe";
  readonly isMock = false;

  private get secretKey() {
    return process.env.STRIPE_SECRET_KEY;
  }

  private get publishableKey() {
    return process.env.STRIPE_PUBLISHABLE_KEY;
  }

  private assertConfigured() {
    if (!this.secretKey) throw new Error("Stripe not configured: set STRIPE_SECRET_KEY");
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.secretKey}:`).toString("base64");
  }

  async createPaymentIntent(input: {
    amountMinor: number;
    currency: Currency;
    description: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    this.assertConfigured();
    const body = new URLSearchParams({
      amount: String(input.amountMinor),
      currency: input.currency.toLowerCase(),
      description: input.description,
      "metadata[idempotencyKey]": input.idempotencyKey,
      ...(input.metadata?.orderId ? { "metadata[orderId]": input.metadata.orderId } : {}),
      ...(input.metadata?.userId ? { "metadata[userId]": input.metadata.userId } : {}),
      ...(input.metadata?.esimId ? { "metadata[esimId]": input.metadata.esimId } : {}),
    });
    const res = await fetch(`${API_BASE}/payment_intents`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (data.error) {
      logger.error("stripe.init_failed", { error: data.error });
      throw new Error(`Stripe init failed: ${data.error.message}`);
    }
    return {
      providerReference: data.id, // pi_...
      clientSecret: data.client_secret,
      status: "pending",
      nextAction: {
        type: "none",
        instructions: "Confirm with your card via Stripe.",
      },
    };
  }

  async verifyPayment(input: {
    providerReference: string;
    idempotencyKey: string;
  }): Promise<PaymentVerification> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/payment_intents/${input.providerReference}`, {
      headers: { Authorization: this.authHeader() },
    });
    const data = await res.json();
    if (data.error) {
      return { status: "failed", providerReference: input.providerReference, raw: data };
    }
    // status: requires_payment_method | requires_confirmation | requires_action | processing | succeeded | canceled
    const status: PaymentVerification["status"] =
      data.status === "succeeded" ? "succeeded" : data.status === "processing" ? "pending" : data.status === "canceled" ? "failed" : "pending";
    // Phase 2B.3.14 P1-5: Stripe provides the settlement timestamp.
    return {
      status,
      providerReference: input.providerReference,
      paidAt: data.status === "succeeded" && data.charges?.data?.[0]?.created
        ? new Date(data.charges.data[0].created * 1000)
        : undefined,
      raw: data,
    };
  }

  async verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<PaymentWebhookEvent | null> {
    // Stripe sends Stripe-Signature header: t=...,v1=...
    if (!this.secretKey || !input.signature) return null;
    const parts = input.signature.split(",");
    const tPart = parts.find((p) => p.startsWith("t="));
    const v1Part = parts.find((p) => p.startsWith("v1="));
    if (!tPart || !v1Part) return null;
    const t = tPart.slice(2);
    const v1 = v1Part.slice(3);
    const expected = createHmac("sha256", this.secretKey).update(`${t}.${input.rawBody}`).digest("hex");
    if (!safeEqual(v1, expected)) return null;
    try {
      const parsed = JSON.parse(input.rawBody);
      const evt = parsed.type; // payment_intent.succeeded, etc.
      const pi = parsed.data?.object;
      const status = pi?.status === "succeeded" ? "succeeded" : pi?.status === "processing" ? "pending" : "failed";
      return {
        externalId: parsed.id,
        eventType: evt,
        data: {
          providerReference: pi?.id,
          status,
          amountMinor: pi?.amount_received != null ? Number(pi.amount_received) : pi?.amount != null ? Number(pi.amount) : undefined,
          // Phase 2B.3.14 P1-5: Stripe webhook provides created timestamp
          paidAt: pi?.status === "succeeded" && pi?.created ? new Date(pi.created * 1000) : undefined,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }
}
