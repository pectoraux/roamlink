/**
 * Canonical domain types — re-exported from @roamlink/shared.
 *
 * This file ensures backward compatibility: existing web imports from
 * `@/types` automatically get the shared types. Both web and mobile
 * consume the same canonical contract from packages/shared.
 *
 * Provider-native shapes NEVER leak here — adapters normalize provider
 * payloads into these types.
 */

export type {
  Currency,
  Region,
  PublicPlan,
  CanonicalPlan,
  OrderStatus,
  PaymentStatus,
  ESIMStatus,
  UsageSample,
  ProvisioningResult,
  TopUpPackage,
  TopUpResult,
  DestinationPage,
  AuthUser,
  ESIM,
  Order,
  CompatibilityResult,
} from "@roamlink/shared";

export { formatPrice, formatDataSize, countryFlag } from "@roamlink/shared";
