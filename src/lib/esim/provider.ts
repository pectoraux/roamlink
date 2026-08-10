/**
 * ESIMProvider — the abstraction boundary.
 *
 * The application NEVER talks to a specific eSIM provider directly. It talks to
 * this interface. Concrete implementations (MockESIMProvider, RealESIMProvider
 * adapter) live in separate files and are selected by ESIM_PROVIDER env var.
 *
 * Provider-native data shapes are normalized into CanonicalPlan /
 * ProvisioningResult by the adapter, so they never leak into the rest of the
 * application.
 */

import type {
  CanonicalPlan,
  ProvisioningResult,
  TopUpPackage,
  TopUpResult,
  UsageSample,
} from "@/types";

export type ProviderPlanInput = {
  providerPlanId: string;
  name: string;
  description?: string;
  country: string;
  countryCode: string;
  region: string;
  dataAmountMB: number;
  validityDays: number;
  wholesalePriceMinor: number;
  currency: import("@/lib/money").Currency;
  coverage?: string;
  networks?: string[];
  roaming?: boolean;
  hotspot?: boolean;
  speed?: string;
  topUpSupported?: boolean;
  /** Raw provider payload, stored server-side only. */
  metadata?: Record<string, unknown>;
};

export interface ESIMProvider {
  /** Stable internal key identifying this provider (e.g. "mock"). */
  readonly id: string;

  /** Human label. */
  readonly label: string;

  /** Whether this is a real (production) provider or a development mock. */
  readonly isMock: boolean;

  /** Fetch the full plan catalog from the provider (provider-native shape). */
  getPlans(): Promise<ProviderPlanInput[]>;

  /** Fetch a single plan by provider plan id. */
  getPlan(providerPlanId: string): Promise<ProviderPlanInput | null>;

  /**
   * Create a provider order for a plan purchase. Returns a provider order id.
   * Must be idempotent w.r.t. the supplied idempotency key.
   */
  createOrder(input: {
    providerPlanId: string;
    idempotencyKey: string;
  }): Promise<{ providerOrderId: string }>;

  /**
   * Provision an eSIM for an existing provider order.
   * Returns SM-DP+ address, ICCID, activation code, etc.
   */
  provisionESIM(input: {
    providerOrderId: string;
    idempotencyKey: string;
  }): Promise<ProvisioningResult>;

  /** Fetch an existing eSIM's current state from the provider. */
  getESIM(providerESIMId: string): Promise<{
    iccid: string;
    smdpAddress: string;
    activationCode: string;
    status: string;
    dataAmountMB: number;
    dataRemainingMB: number;
    expiresAt: string;
  }>;

  /** Fetch current usage for an eSIM. */
  getUsage(providerESIMId: string): Promise<UsageSample>;

  /** Whether top-ups are supported for a given eSIM. */
  supportsTopUp(providerESIMId: string): Promise<boolean>;

  /** List available top-up packages for an eSIM. */
  getTopUpPackages(providerESIMId: string): Promise<TopUpPackage[]>;

  /** Apply a top-up. Idempotent via idempotencyKey. */
  topUp(input: {
    providerESIMId: string;
    packageId: string;
    idempotencyKey: string;
  }): Promise<TopUpResult>;

  /** Cancel an eSIM where supported. */
  cancel(providerESIMId: string): Promise<void>;

  /**
   * Verify an inbound webhook signature + payload. Returns the parsed event
   * or null if invalid. Mock providers may use a shared secret scheme.
   */
  verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<ProviderWebhookEvent | null>;
}

export type ProviderWebhookEvent = {
  externalId: string;
  eventType: string;
  /** Normalized payload the application can act on. */
  data: {
    providerESIMId?: string;
    providerOrderId?: string;
    status?: string;
    dataRemainingMB?: number;
    expiresAt?: string;
  };
  raw: unknown;
};
