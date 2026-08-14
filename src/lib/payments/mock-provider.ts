/**
 * MockPaymentProvider — simulates payment pending / success / failure.
 *
 * In development mode, payments "succeed" synchronously but still go through
 * the full server-side verification path so the application logic is exercised
 * exactly as it would be with a real provider. A special card/test value can
 * force a failure to test failure paths.
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

type MockIntent = {
  providerReference: string;
  amountMinor: number;
  currency: Currency;
  status: "pending" | "succeeded" | "failed";
  // Test hook: intents created with metadata.forceFail will fail verification.
  forceFail: boolean;
  // Phase 2B.3.14 P1-5: The timestamp when the mock intent was confirmed.
  // This simulates the provider's authoritative payment timestamp.
  confirmedAt?: Date;
};

const intents = new Map<string, MockIntent>();
const intentByIdem = new Map<string, string>();

/**
 * Phase 2B.3.16: Test instrumentation — counts createPaymentIntent calls.
 * Used by concurrency tests to prove that only ONE worker calls createPaymentIntent
 * even when multiple workers race from providerReference = NULL.
 */
let createPaymentIntentCallCount = 0;

/** Get the total number of createPaymentIntent calls (test instrumentation). */
export function getCreatePaymentIntentCallCount(): number {
  return createPaymentIntentCallCount;
}

/** Reset the call counter (test instrumentation). */
export function resetCreatePaymentIntentCallCount(): void {
  createPaymentIntentCallCount = 0;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly id = "mock";
  readonly label = "Mock Payment Provider (Development)";
  readonly isMock = true;

  async createPaymentIntent(input: {
    amountMinor: number;
    currency: Currency;
    description: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    // Phase 2B.3.16: Increment the call counter for test instrumentation.
    createPaymentIntentCallCount++;
    // Idempotent: same key returns same intent.
    let providerReference = intentByIdem.get(input.idempotencyKey);
    if (!providerReference) {
      providerReference = `mock-pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      intentByIdem.set(input.idempotencyKey, providerReference);
      const forceFail = input.metadata?.forceFail === "true";
      intents.set(providerReference, {
        providerReference,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "pending",
        forceFail,
      });
      logger.info("mock.payment_intent_created", { providerReference, amountMinor: input.amountMinor });
    }
    return {
      providerReference,
      status: "pending",
      nextAction: {
        type: "none",
        instructions: "Mock payment — confirm on the client to simulate payment.",
      },
    };
  }

  async verifyPayment(input: {
    providerReference: string;
    idempotencyKey: string;
  }): Promise<PaymentVerification> {
    const intent = intents.get(input.providerReference);
    if (!intent) {
      return {
        status: "failed",
        providerReference: input.providerReference,
        raw: { reason: "unknown_intent" },
      };
    }
    // In mock mode, the "confirmation" happens client-side via the confirm
    // endpoint, which marks the intent succeeded. Here we read back the truth.
    if (intent.forceFail) {
      intent.status = "failed";
      return { status: "failed", providerReference: intent.providerReference, raw: { reason: "forced_failure" } };
    }
    return {
      status: intent.status === "pending" ? "pending" : intent.status,
      providerReference: intent.providerReference,
      // Phase 2B.3.14 P1-5: Return the authoritative payment timestamp.
      // This is set when confirmIntent() is called — simulating the provider's
      // settlement time, which may differ from when we call verifyPayment().
      paidAt: intent.status === "succeeded" && intent.confirmedAt ? intent.confirmedAt : undefined,
      // Phase 2B.3.18 P0: Return the amount and currency for invoice correlation.
      // These allow resolveAmbiguousPayment() to verify that a manually-recovered
      // payment reference actually corresponds to THIS invoice.
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      raw: { amountMinor: intent.amountMinor, currency: intent.currency },
    };
  }

  /** Dev-only: mark a mock intent as succeeded (simulates client confirmation). */
  confirmIntent(providerReference: string): boolean {
    const intent = intents.get(providerReference);
    if (!intent) return false;
    if (intent.forceFail) {
      intent.status = "failed";
      return false;
    }
    intent.status = "succeeded";
    // Phase 2B.3.14 P1-5: Record the authoritative confirmation timestamp.
    intent.confirmedAt = new Date();
    logger.info("mock.payment_confirmed", { providerReference, paidAt: intent.confirmedAt });
    return true;
  }

  async verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<PaymentWebhookEvent | null> {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret) return null;
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
    if (!input.signature || !safeEqual(input.signature, expected)) return null;
    try {
      const parsed = JSON.parse(input.rawBody);
      return {
        externalId: String(parsed.id ?? `evt-${Date.now()}`),
        eventType: String(parsed.type ?? "payment.succeeded"),
        data: {
          providerReference: parsed.providerReference ?? parsed.reference,
          status: parsed.status,
          amountMinor: parsed.amountMinor != null ? Number(parsed.amountMinor) : undefined,
          // Phase 2B.3.14 P1-5: pass through provider paidAt if provided
          paidAt: parsed.paidAt ? new Date(parsed.paidAt) : undefined,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }
}

export const mockPaymentProvider = new MockPaymentProvider();
