/**
 * PayStack payment adapter.
 *
 * PayStack flow (test mode):
 *   1. Initialize transaction → returns `reference` + `authorization_url`
 *   2. Customer pays on PayStack-hosted page (or test card)
 *   3. Server verifies via GET /transaction/verify/:reference
 *   4. Webhook → /transaction/webhook (signed with PAYSTACK_SECRET_KEY)
 *
 * Docs: https://paystack.com/docs/api/
 *
 * Credentials come from PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY (server-only).
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

const API_BASE = "https://api.paystack.co";

function toPaystackAmount(minor: number, currency: Currency): number {
  // PayStack expects amounts in the smallest currency unit (kobo/cents).
  return minor;
}

function fromPaystackAmount(amount: number): number {
  return amount; // already minor units
}

export class PayStackProvider implements PaymentProvider {
  readonly id = "paystack";
  readonly label = "PayStack";
  readonly isMock = false;

  private get secretKey() {
    return process.env.PAYSTACK_SECRET_KEY;
  }

  private get publicKey() {
    return process.env.PAYSTACK_PUBLIC_KEY;
  }

  private assertConfigured() {
    if (!this.secretKey) throw new Error("PayStack not configured: set PAYSTACK_SECRET_KEY");
  }

  async createPaymentIntent(input: {
    amountMinor: number;
    currency: Currency;
    description: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: input.metadata?.email || "customer@roamlink.app",
        amount: toPaystackAmount(input.amountMinor, input.currency),
        currency: input.currency,
        reference: input.idempotencyKey, // PayStack reference = our idempotency key
        callback_url: `${process.env.NEXT_PUBLIC_APP_URL || ""}/order/${input.metadata?.orderId ?? ""}`,
        metadata: { custom_fields: [{ display_name: "Description", variable_name: "description", value: input.description }], ...input.metadata },
      }),
    });
    const data = await res.json();
    if (!data.status) {
      logger.error("paystack.init_failed", { data });
      throw new Error(`PayStack init failed: ${data.message}`);
    }
    return {
      providerReference: data.data.reference,
      status: "pending",
      nextAction: {
        type: "redirect",
        url: data.data.authorization_url,
        instructions: "You'll be redirected to PayStack to complete payment.",
      },
    };
  }

  async verifyPayment(input: {
    providerReference: string;
    idempotencyKey: string;
  }): Promise<PaymentVerification> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/transaction/verify/${encodeURIComponent(input.providerReference)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const data = await res.json();
    if (!data.status) {
      return { status: "failed", providerReference: input.providerReference, raw: data };
    }
    const status = data.data.status; // success | failed | abandoned | pending
    const mapped: PaymentVerification["status"] =
      status === "success" ? "succeeded" : status === "pending" ? "pending" : "failed";
    // Phase 2B.3.14 P1-5: PayStack provides paidAt as `paid_at` (ISO string).
    const paidAtStr = data.data.paid_at || data.data.paidAt;
    return {
      status: mapped,
      providerReference: input.providerReference,
      paidAt: mapped === "succeeded" && paidAtStr ? new Date(paidAtStr) : undefined,
      // Phase 2B.3.18 P0: PayStack provides amount and currency.
      amountMinor: data.data.amount != null ? Number(data.data.amount) : undefined,
      currency: data.data.currency ? String(data.data.currency).toUpperCase() : undefined,
      raw: data.data,
    };
  }

  async verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<PaymentWebhookEvent | null> {
    // PayStack signs with HMAC-SHA512 of the raw body using the secret key.
    if (!this.secretKey || !input.signature) return null;
    const expected = createHmac("sha512", this.secretKey).update(input.rawBody).digest("hex");
    if (!safeEqual(input.signature, expected)) return null;
    try {
      const parsed = JSON.parse(input.rawBody);
      const evt = parsed.event; // charge.success, etc.
      const ref = parsed.data?.reference;
      const status = parsed.data?.status === "success" ? "succeeded" : parsed.data?.status === "pending" ? "pending" : "failed";
      const paidAtStr = parsed.data?.paid_at || parsed.data?.paidAt;
      return {
        externalId: `${ref}-${evt}`,
        eventType: evt,
        data: {
          providerReference: ref,
          status,
          amountMinor: parsed.data?.amount != null ? fromPaystackAmount(Number(parsed.data.amount)) : undefined,
          // Phase 2B.3.14 P1-5: PayStack webhook provides paid_at
          paidAt: status === "succeeded" && paidAtStr ? new Date(paidAtStr) : undefined,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }
}
