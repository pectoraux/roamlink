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
  cached = getPaymentProviderByKey(key);
  return cached;
}

/**
 * Phase 2B.3.3: Resolve a payment provider by its key string.
 * Used to resolve the correct provider from an invoice's `paymentProvider` field,
 * rather than using the global configured provider.
 *
 * This ensures that an invoice created under Provider A continues to use
 * Provider A even if the platform's default provider changes to Provider B.
 */
const providerCache = new Map<string, PaymentProvider>();

export function getPaymentProviderByKey(providerKey: string): PaymentProvider {
  const key = providerKey.toLowerCase();
  if (providerCache.has(key)) return providerCache.get(key)!;

  let provider: PaymentProvider;
  switch (key) {
    case "mock":
      provider = mockPaymentProvider;
      break;
    case "paystack":
      provider = new PayStackProvider();
      break;
    case "flutterwave":
      provider = new FlutterwaveProvider();
      break;
    case "stripe":
      provider = new StripeProvider();
      break;
    default:
      throw new Error(
        `Unknown payment provider "${providerKey}". Supported: mock, paystack, flutterwave, stripe.`,
      );
  }
  providerCache.set(key, provider);
  return provider;
}

export type { PaymentProvider } from "./provider";
export { MockPaymentProvider, mockPaymentProvider } from "./mock-provider";
export { PayStackProvider } from "./paystack-provider";
export { FlutterwaveProvider } from "./flutterwave-provider";
export { StripeProvider } from "./stripe-provider";
// Phase 2B.3.16: Test instrumentation for concurrency tests.
export { getCreatePaymentIntentCallCount, resetCreatePaymentIntentCallCount } from "./mock-provider";
