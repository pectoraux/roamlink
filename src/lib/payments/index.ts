/**
 * Payment provider factory — selects the concrete provider from PAYMENT_PROVIDER.
 */

import type { PaymentProvider } from "./provider";
import { MockPaymentProvider, mockPaymentProvider } from "./mock-provider";

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const key = (process.env.PAYMENT_PROVIDER || "mock").toLowerCase();
  switch (key) {
    case "mock":
      cached = mockPaymentProvider;
      break;
    default:
      // Real providers (Stripe, Paystack, etc.) would be implemented as
      // separate adapters selected here. We do not fabricate them.
      throw new Error(
        `Payment provider "${key}" is not implemented. Implement a concrete adapter and register it here. For development, set PAYMENT_PROVIDER=mock.`,
      );
  }
  return cached;
}

export type { PaymentProvider } from "./provider";
export { MockPaymentProvider, mockPaymentProvider } from "./mock-provider";
