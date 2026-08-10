/**
 * Canonical domain types shared across the application.
 *
 * These are the INTERNAL marketplace models. Provider-native shapes NEVER leak
 * here — adapters are responsible for normalizing provider payloads into these.
 */

import type { Currency } from "@/lib/money";

export type Region =
  | "Africa"
  | "Europe"
  | "North America"
  | "South America"
  | "Asia"
  | "Oceania"
  | "Middle East";

/** Canonical plan as used throughout the marketplace & API. */
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

/** Public plan (never includes wholesale cost). */
export type PublicPlan = Omit<CanonicalPlan, "providerPlanId"> & {
  providerId: string;
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

export type UsageSample = {
  dataUsedMB: number;
  dataRemainingMB: number;
  timestamp: string;
};

/** eSIM provisioning result from a provider. */
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

/** A top-up package offered by the provider. */
export type TopUpPackage = {
  id: string;
  name: string;
  dataAmountMB: number;
  priceMinor: number;
  currency: Currency;
  validityDays?: number;
};

/** Top-up result. */
export type TopUpResult = {
  providerReference: string;
  dataAddedMB: number;
  newRemainingMB: number;
  newExpiresAt?: string;
};
