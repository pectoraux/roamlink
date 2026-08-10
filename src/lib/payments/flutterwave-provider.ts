/**
 * Flutterwave payment adapter.
 *
 * Flutterwave flow (test mode):
 *   1. Initiate payment → returns `flw_ref` + `payment_link`
 *   2. Customer pays on Flutterwave-hosted modal/page
 *   3. Server verifies via POST /transactions/:id/verify
 *   4. Webhook → signed with FLUTTERWAVE_SECRET_KEY (verifying hash)
 *
 * Docs: https://developer.flutterwave.com/
 *
 * Credentials from FLUTTERWAVE_SECRET_KEY / FLUTTERWAVE_PUBLIC_KEY / FLUTTERWAVE_ENCRYPTION_KEY.
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
import { createHash } from "crypto";

const API_BASE = "https://api.flutterwave.com/v3";

export class FlutterwaveProvider implements PaymentProvider {
  readonly id = "flutterwave";
  readonly label = "Flutterwave";
  readonly isMock = false;

  private get secretKey() {
    return process.env.FLUTTERWAVE_SECRET_KEY;
  }

  private get publicKey() {
    return process.env.FLUTTERWAVE_PUBLIC_KEY;
  }

  private assertConfigured() {
    if (!this.secretKey) throw new Error("Flutterwave not configured: set FLUTTERWAVE_SECRET_KEY");
  }

  async createPaymentIntent(input: {
    amountMinor: number;
    currency: Currency;
    description: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    this.assertConfigured();
    const txRef = input.idempotencyKey;
    const res = await fetch(`${API_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: input.amountMinor / 100, // Flutterwave uses major units
        currency: input.currency,
        redirect_url: `${process.env.NEXT_PUBLIC_APP_URL || ""}/order/${input.metadata?.orderId ?? ""}`,
        customer: {
          email: input.metadata?.email || "customer@roamlink.app",
          name: input.metadata?.name || undefined,
        },
        payment_options: "card",
        meta: { description: input.description, ...input.metadata },
        customizations: { title: "RoamLink eSIM", description: input.description },
      }),
    });
    const data = await res.json();
    if (data.status !== "success") {
      logger.error("flutterwave.init_failed", { data });
      throw new Error(`Flutterwave init failed: ${data.message}`);
    }
    return {
      providerReference: txRef,
      status: "pending",
      nextAction: {
        type: "redirect",
        url: data.data.link,
        instructions: "You'll be redirected to Flutterwave to complete payment.",
      },
    };
  }

  async verifyPayment(input: {
    providerReference: string;
    idempotencyKey: string;
  }): Promise<PaymentVerification> {
    this.assertConfigured();
    // Flutterwave verifies by transaction id, but we store tx_ref. We can look up
    // by tx_ref via /transactions?tx_ref=... then verify. For simplicity in test
    // mode, we fetch the transaction set and find by tx_ref.
    const res = await fetch(`${API_BASE}/transactions?tx_ref=${encodeURIComponent(input.providerReference)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const data = await res.json();
    if (data.status !== "success" || !data.data?.length) {
      return { status: "pending", providerReference: input.providerReference, raw: data };
    }
    const tx = data.data[0];
    const status = tx.status === "successful" ? "succeeded" : tx.status === "pending" ? "pending" : "failed";
    return {
      status,
      providerReference: input.providerReference,
      raw: tx,
    };
  }

  async verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<PaymentWebhookEvent | null> {
    // Flutterwave: verify by comparing vericheck hash = SHA256(secret + rawBody)
    if (!this.secretKey || !input.signature) return null;
    const expected = createHash("sha256").update(this.secretKey + input.rawBody).digest("hex");
    if (!safeEqual(input.signature, expected)) return null;
    try {
      const parsed = JSON.parse(input.rawBody);
      const evt = parsed.event; // charge.completed, etc.
      const ref = parsed.data?.tx_ref;
      const status = parsed.data?.status === "successful" ? "succeeded" : parsed.data?.status === "pending" ? "pending" : "failed";
      return {
        externalId: `${ref}-${evt}`,
        eventType: evt,
        data: {
          providerReference: ref,
          status,
          amountMinor: parsed.data?.amount != null ? Math.round(Number(parsed.data.amount) * 100) : undefined,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }
}
