/**
 * Shared domain types — consumed by both web (Next.js) and mobile (Expo).
 *
 * These are the canonical marketplace models. Provider-native shapes NEVER
 * leak here — adapters normalize provider payloads into these.
 */

export type Currency = "USD" | "EUR" | "XOF";

export type Region =
  | "Africa"
  | "Europe"
  | "North America"
  | "South America"
  | "Asia"
  | "Oceania"
  | "Middle East";

/** Public plan (never includes wholesale cost). */
export type PublicPlan = {
  id: string;
  providerId: string;
  name: string;
  description: string | null;
  country: string;
  countryCode: string;
  region: string;
  dataAmountMB: number;
  dataUnit: string;
  validityDays: number;
  priceMinor: number;
  currency: Currency;
  coverage: string | null;
  networks: string[];
  roaming: boolean;
  hotspot: boolean;
  speed: string | null;
  topUpSupported: boolean;
  status: "active" | "inactive";
};

export type OrderStatus =
  | "PLAN_SELECTED"
  | "CHECKOUT_CREATED"
  | "PAYMENT_PENDING"
  | "PAYMENT_CONFIRMED"
  | "ESIM_PROVISIONING"
  | "ESIM_PROVISIONED"
  | "COMPLETED"
  | "PAYMENT_FAILED"
  | "PROVISIONING_FAILED"
  | "CANCELLED"
  | "REFUNDED";

export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";

export type ESIMStatus =
  | "pending"
  | "active"
  | "expired"
  | "suspended"
  | "exhausted"
  | "cancelled";

export type DestinationPage = {
  country: string;
  countryCode: string;
  region: string;
  slug: string;
  plans: PublicPlan[];
  coverage: string | null;
  networks: string[];
  speed: string | null;
  minPriceMinor: number;
  planCount: number;
};

export type TopUpPackage = {
  id: string;
  name: string;
  dataAmountMB: number;
  priceMinor: number;
  currency: Currency;
  validityDays?: number;
};

export type UsageSample = {
  dataUsedMB: number;
  dataRemainingMB: number;
  timestamp: string;
};

/** Result of provisioning a connectivity product via a supplier adapter. */
export type ProvisioningResult = {
  providerESIMId: string;
  iccid: string;
  smdpAddress: string;
  activationCode: string;
  matchId?: string;
  dataAmountMB: number;
  validityDays: number;
  expiresAt: string;
};

/** Result of a top-up operation. */
export type TopUpResult = {
  providerTopUpId: string;
  dataAddedMB: number;
  newRemainingMB: number;
  expiresAt?: string;
};

/** Canonical plan (internal — includes wholesale cost). */
export type CanonicalPlan = {
  id: string;
  providerId: string;
  providerPlanId: string;
  name: string;
  description: string | null;
  country: string;
  countryCode: string;
  region: string;
  dataAmountMB: number;
  dataUnit: string;
  validityDays: number;
  priceMinor: number;
  currency: Currency;
  coverage: string | null;
  networks: string[];
  roaming: boolean;
  hotspot: boolean;
  speed: string | null;
  topUpSupported: boolean;
  status: "active" | "inactive";
};

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  role: "customer" | "admin";
  isDemo: boolean;
};

export type ESIM = {
  id: string;
  status: ESIMStatus;
  dataAmount: number;
  dataRemaining: number;
  validityDays: number;
  expiresAt: string | null;
  iccid: string | null;
  smdpAddress: string | null;
  activationCode: string | null;
  matchId: string | null;
  qrCode: string | null;
  provider: string;
  order: { id: string; plan: { country: string; countryCode: string; name: string; networks: string | null; speed: string | null } };
};

export type Order = {
  id: string;
  status: OrderStatus;
  amountMinor: number;
  currency: string;
  paymentStatus: string;
  planName: string;
  country: string;
  countryCode: string;
  dataAmountMB: number;
  validityDays: number;
  esimId: string | null;
  failureReason: string | null;
  createdAt: string;
};

export type CompatibilityResult = {
  device: string;
  esimCompatible: boolean;
  nativeInstallationSupported: boolean;
  platform: "ios" | "android" | "unknown";
  notes?: string;
};

/** Shared formatting helpers (isomorphic). */
export function formatPrice(minor: number, currency: Currency | string = "USD"): string {
  const symbols: Record<string, string> = { USD: "$", EUR: "€", XOF: "CFA " };
  const symbol = symbols[currency] ?? "";
  return `${symbol}${(minor / 100).toFixed(2)}`;
}

export function formatDataSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

export function countryFlag(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return "🌐";
  return String.fromCodePoint(...countryCode.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// Virtual Number types (second connectivity product)
// ---------------------------------------------------------------------------

export type NumberStatus =
  | "discovered"
  | "available"
  | "reserved"
  | "provisioning"
  | "configuring"
  | "active"
  | "suspended"
  | "releasing"
  | "released"
  | "failed";

export type NumberType = "local" | "toll_free" | "mobile" | "national";

export type ProviderNumber = {
  providerNumberId: string;
  e164: string;
  country: string;
  countryCode: string;
  region?: string;
  city?: string;
  numberType: NumberType;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  voiceEnabled: boolean;
  monthlyCostMinor: number;
  currency: Currency;
  sellingPriceMinor: number;
};

export type VirtualNumber = {
  id: string;
  e164: string;
  country: string;
  countryCode: string;
  region: string | null;
  city: string | null;
  numberType: string;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  voiceEnabled: boolean;
  status: NumberStatus;
  provider: string;
  sellingPrice: number;
  currency: string;
  expiresAt: string | null;
  activatedAt: string | null;
  createdAt: string;
};

export type Message = {
  id: string;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  segments: number;
  createdAt: string;
};

export type Call = {
  id: string;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  status: string;
  durationSeconds: number;
  createdAt: string;
};

export type NumberCountry = {
  country: string;
  countryCode: string;
  sms: boolean;
  voice: boolean;
  mms: boolean;
  count: number;
  regions: string[];
};

export * from "./api-client";
export * from "./edge-observation";
export * from "./current-connectivity";
