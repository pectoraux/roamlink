/**
 * Payment provider factory — selects the concrete provider from PAYMENT_PROVIDER.
 *
 * Supported: mock | paystack | flutterwave | stripe
 *
 * Switching providers is a pure env-var change. Each adapter implements the
 * same PaymentProvider interface with server-side verification.
 */

import type { PaymentProvider } from "./provider";
import { MockPaymentProvider, mockPaymentProvider } from "./mock-provider";
import { PayStackProvider } from "./paystack-provider";
import { FlutterwaveProvider } from "./flutterwave-provider";
import { StripeProvider } from "./stripe-provider";

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const key = (process.env.PAYMENT_PROVIDER || "mock").toLowerCase();
  switch (key) {
    case "mock":
      cached = mockPaymentProvider;
      break;
    case "paystack":
      cached = new PayStackProvider();
      break;
    case "flutterwave":
      cached = new FlutterwaveProvider();
      break;
    case "stripe":
      cached = new StripeProvider();
      break;
    default:
      throw new Error(
        `Unknown PAYMENT_PROVIDER "${key}". Supported: mock, paystack, flutterwave, stripe.`,
      );
  }
  return cached;
}

export type { PaymentProvider } from "./provider";
export { MockPaymentProvider, mockPaymentProvider } from "./mock-provider";
export { PayStackProvider } from "./paystack-provider";
export { FlutterwaveProvider } from "./flutterwave-provider";
export { StripeProvider } from "./stripe-provider";
