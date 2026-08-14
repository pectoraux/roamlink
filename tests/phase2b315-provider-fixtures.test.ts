/**
 * Phase 2B.3.15 — Provider Adapter Fixture Tests
 *
 * Tests provider paidAt extraction against DOCUMENTED provider response shapes.
 * These are NOT mock shapes invented by us — they use the actual response
 * structures documented in the Stripe, Paystack, and Flutterwave API docs.
 *
 * Each test:
 *   1. Constructs a provider-native response fixture (from API docs)
 *   2. Feeds it to the adapter's verifyPayment/verifyWebhook
 *   3. Asserts the extracted paidAt matches the documented timestamp
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { StripeProvider } from "@/lib/payments/stripe-provider";
import { PayStackProvider } from "@/lib/payments/paystack-provider";
import { FlutterwaveProvider } from "@/lib/payments/flutterwave-provider";
import { MockPaymentProvider, mockPaymentProvider } from "@/lib/payments/mock-provider";

// ---------------------------------------------------------------------------
// Stripe — documented response shapes from https://stripe.com/docs/api/payment_intents/object
// ---------------------------------------------------------------------------

describe("Stripe provider paidAt extraction", () => {
  let provider: StripeProvider;

  beforeAll(() => {
    provider = new StripeProvider();
    // Mock the environment variable
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
  });

  it("verifyPayment extracts paidAt from charges.data[0].created (Unix timestamp)", async () => {
    // Stripe PaymentIntent object (simplified from docs):
    // {
    //   "id": "pi_3abc123",
    //   "status": "succeeded",
    //   "charges": {
    //     "data": [{ "created": 1691614800, ... }]
    //   }
    // }
    // 1691614800 = 2023-08-09T21:00:00Z
    const stripeResponse = {
      id: "pi_3abc123",
      object: "payment_intent",
      status: "succeeded",
      amount: 2900,
      currency: "usd",
      charges: {
        object: "list",
        data: [
          {
            id: "ch_3abc123",
            object: "charge",
            created: 1691614800,
            amount: 2900,
            status: "succeeded",
          },
        ],
      },
    };

    // Intercept fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(stripeResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    try {
      const result = await provider.verifyPayment({
        providerReference: "pi_3abc123",
        idempotencyKey: "test-key",
      });

      expect(result.status).toBe("succeeded");
      expect(result.paidAt).toBeInstanceOf(Date);
      expect(result.paidAt!.getTime()).toBe(1691614800 * 1000);
      expect(result.paidAt!.toISOString()).toBe("2023-08-09T21:00:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifyPayment does NOT return paidAt for non-succeeded status", async () => {
    const stripeResponse = {
      id: "pi_3abc456",
      status: "processing",
      amount: 2900,
      currency: "usd",
      charges: { data: [] },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(stripeResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    try {
      const result = await provider.verifyPayment({
        providerReference: "pi_3abc456",
        idempotencyKey: "test-key",
      });

      expect(result.status).toBe("pending");
      expect(result.paidAt).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifyWebhook extracts paidAt from pi.created (Unix timestamp)", async () => {
    // Stripe webhook event (payment_intent.succeeded):
    // {
    //   "id": "evt_123",
    //   "type": "payment_intent.succeeded",
    //   "data": {
    //     "object": {
    //       "id": "pi_3abc123",
    //       "status": "succeeded",
    //       "created": 1691614800,
    //       ...
    //     }
    //   }
    // }
    // Note: Stripe webhook uses the PaymentIntent's `created` field,
    // while verifyPayment uses `charges.data[0].created`. Both are Unix timestamps.
    const webhookPayload = JSON.stringify({
      id: "evt_123",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_3abc123",
          status: "succeeded",
          created: 1691614800,
          amount_received: 2900,
        },
      },
    });

    // Stripe signature: t=timestamp,v1=hex
    // We need to compute a valid signature for the test to pass verification.
    const { createHmac } = await import("crypto");
    const t = String(Math.floor(Date.now() / 1000));
    const signedPayload = `${t}.${webhookPayload}`;
    const v1 = createHmac("sha256", "sk_test_fixture").update(signedPayload).digest("hex");
    const signature = `t=${t},v1=${v1}`;

    const result = await provider.verifyWebhook({
      signature,
      rawBody: webhookPayload,
    });

    expect(result).not.toBeNull();
    expect(result!.data.status).toBe("succeeded");
    expect(result!.data.paidAt).toBeInstanceOf(Date);
    expect(result!.data.paidAt!.getTime()).toBe(1691614800 * 1000);
  });
});

// ---------------------------------------------------------------------------
// PayStack — documented response shapes from https://paystack.com/docs/api/
// ---------------------------------------------------------------------------

describe("PayStack provider paidAt extraction", () => {
  let provider: PayStackProvider;

  beforeAll(() => {
    provider = new PayStackProvider();
    process.env.PAYSTACK_SECRET_KEY = "sk_test_fixture";
  });

  it("verifyPayment extracts paidAt from paid_at (ISO string)", async () => {
    // PayStack transaction verify response:
    // {
    //   "status": true,
    //   "data": {
    //     "status": "success",
    //     "reference": "ref123",
    //     "amount": 290000,
    //     "paid_at": "2023-08-09T21:00:00.000Z",
    //     ...
    //   }
    // }
    const paystackResponse = {
      status: true,
      message: "Verification successful",
      data: {
        status: "success",
        reference: "ref123",
        amount: 290000,
        currency: "USD",
        paid_at: "2023-08-09T21:00:00.000Z",
        created_at: "2023-08-09T20:59:00.000Z",
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(paystackResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    try {
      const result = await provider.verifyPayment({
        providerReference: "ref123",
        idempotencyKey: "test-key",
      });

      expect(result.status).toBe("succeeded");
      expect(result.paidAt).toBeInstanceOf(Date);
      expect(result.paidAt!.toISOString()).toBe("2023-08-09T21:00:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifyPayment does NOT return paidAt for pending status", async () => {
    const paystackResponse = {
      status: true,
      data: {
        status: "pending",
        reference: "ref456",
        amount: 290000,
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(paystackResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    try {
      const result = await provider.verifyPayment({
        providerReference: "ref456",
        idempotencyKey: "test-key",
      });

      expect(result.status).toBe("pending");
      expect(result.paidAt).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Flutterwave — documented response shapes from https://developer.flutterwave.com/
// ---------------------------------------------------------------------------

describe("Flutterwave provider paidAt extraction", () => {
  let provider: FlutterwaveProvider;

  beforeAll(() => {
    provider = new FlutterwaveProvider();
    process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-fixture";
  });

  it("verifyPayment extracts paidAt from created_at (ISO string)", async () => {
    // Flutterwave transaction verify response:
    // GET /transactions?tx_ref=...
    // {
    //   "status": "success",
    //   "data": [{
    //     "status": "successful",
    //     "tx_ref": "ref123",
    //     "amount": 29.00,
    //     "created_at": "2023-08-09T21:00:00.000Z",
    //     ...
    //   }]
    // }
    const flutterwaveResponse = {
      status: "success",
      message: "Transactions fetched",
      data: [
        {
          id: 12345,
          tx_ref: "ref123",
          status: "successful",
          amount: 29.00,
          currency: "USD",
          created_at: "2023-08-09T21:00:00.000Z",
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(flutterwaveResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    try {
      const result = await provider.verifyPayment({
        providerReference: "ref123",
        idempotencyKey: "test-key",
      });

      expect(result.status).toBe("succeeded");
      expect(result.paidAt).toBeInstanceOf(Date);
      expect(result.paidAt!.toISOString()).toBe("2023-08-09T21:00:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Mock provider — verifies the confirmedAt → paidAt contract
// ---------------------------------------------------------------------------

describe("Mock provider paidAt extraction", () => {
  it("verifyPayment returns paidAt matching confirmIntent time", async () => {
    const intent = await mockPaymentProvider.createPaymentIntent({
      amountMinor: 2900,
      currency: "USD" as any,
      description: "Test",
      idempotencyKey: `mock_paidAt_test_${Date.now()}`,
    });

    // Before confirmation: no paidAt
    const before = await mockPaymentProvider.verifyPayment({
      providerReference: intent.providerReference,
      idempotencyKey: "test-key",
    });
    expect(before.status).toBe("pending");
    expect(before.paidAt).toBeUndefined();

    // Confirm and capture the timestamp
    mockPaymentProvider.confirmIntent(intent.providerReference);

    // After confirmation: paidAt should be set
    const after = await mockPaymentProvider.verifyPayment({
      providerReference: intent.providerReference,
      idempotencyKey: "test-key",
    });
    expect(after.status).toBe("succeeded");
    expect(after.paidAt).toBeInstanceOf(Date);
    // paidAt should be very recent (within the last few seconds)
    const now = Date.now();
    expect(after.paidAt!.getTime()).toBeGreaterThan(now - 5000);
    expect(after.paidAt!.getTime()).toBeLessThanOrEqual(now);
  });

  it("verifyPayment returns paidAt from webhook payload", async () => {
    const { createHmac } = await import("crypto");
    process.env.PAYMENT_WEBHOOK_SECRET = "test-secret";
    const payload = JSON.stringify({
      id: "evt_mock_1",
      type: "payment.succeeded",
      providerReference: "mock-pay-test-ref",
      status: "succeeded",
      paidAt: "2023-08-09T21:00:00.000Z",
    });
    const sig = createHmac("sha256", "test-secret").update(payload).digest("hex");

    const result = await mockPaymentProvider.verifyWebhook({
      signature: sig,
      rawBody: payload,
    });

    expect(result).not.toBeNull();
    expect(result!.data.paidAt).toBeInstanceOf(Date);
    expect(result!.data.paidAt!.toISOString()).toBe("2023-08-09T21:00:00.000Z");
  });
});
