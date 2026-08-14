/**
 * PaymentProvider — abstraction boundary for payments.
 *
 * The application NEVER trusts the client's claim that payment succeeded. The
 * flow is:
 *   1. createPaymentIntent() -> returns a client token/reference + status
 *   2. Client confirms payment (provider-hosted or SDK)
 *   3. confirmPayment() on the server -> server verifies with provider
 *   4. Webhook /api/webhooks/payment -> idempotent confirmation
 */

import type { Currency } from "@/lib/money";

export type PaymentIntentResult = {
  providerReference: string;
  clientSecret?: string;
  status: "pending" | "succeeded" | "failed";
  /** Next action for the client (e.g. redirect URL). */
  nextAction?: {
    type: "redirect" | "otp" | "none";
    url?: string;
    instructions?: string;
  };
};

export type PaymentVerification = {
  status: "succeeded" | "failed" | "pending";
  providerReference: string;
  /**
   * Phase 2B.3.14 P1-4: The authoritative payment timestamp from the provider.
   * Used as the source of truth for invoice.paidAt — NEVER the worker execution
   * time. This prevents billing-period drift when reconciliation finalizes a
   * stale-pending invoice days after the actual payment.
   *
   * Providers should normalize their settlement/paid timestamp into this field.
   * If the provider doesn't expose a timestamp, undefined is returned and the
   * caller falls back to new Date() (with a warning log).
   */
  paidAt?: Date;
  /** Raw provider response — server-side only. */
  raw?: unknown;
};

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;

  /** Create a payment intent for an order. Idempotent via idempotencyKey. */
  createPaymentIntent(input: {
    amountMinor: number;
    currency: Currency;
    description: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult>;

  /**
   * Server-side verification of a payment. NEVER trust the client. This calls
   * the provider to confirm the payment actually succeeded.
   */
  verifyPayment(input: {
    providerReference: string;
    idempotencyKey: string;
  }): Promise<PaymentVerification>;

  /** Verify an inbound webhook signature + payload. */
  verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<PaymentWebhookEvent | null>;
}

export type PaymentWebhookEvent = {
  externalId: string;
  eventType: string;
  data: {
    providerReference?: string;
    status?: "succeeded" | "failed" | "pending";
    amountMinor?: number;
    /** Phase 2B.3.14 P1-5: Provider's authoritative payment timestamp. */
    paidAt?: Date;
  };
  raw: unknown;
};
