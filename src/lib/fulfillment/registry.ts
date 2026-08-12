/**
 * Fulfillment Registry — registers fulfillment adapters and persistence handlers.
 *
 * Phase 2E P0 FIX: The registry now supports MULTIPLE provider instances
 * simultaneously. Each providerKey maps to a DIFFERENT adapter, bound to a
 * DIFFERENT provider instance at registration time.
 *
 * The purchase path NEVER calls getESIMProvider(). Provider selection is:
 *   Supplier.providerKey → getAdapter(providerKey) → adapter (bound provider instance)
 *
 * The legacy getESIMProvider() singleton is NOT used in the purchase path.
 * It remains only for catalog sync, usage tracking, and webhooks — none of
 * which determine which supplier fulfills an order.
 */

import { registerAdapter, registerPersistenceHandler } from "./adapter";
import { makeESIMFulfillmentAdapter } from "./esim-adapter";
import { ESIMFulfillmentPersistence } from "./esim-persistence";
import { MockESIMProvider, mockESIMProvider } from "@/lib/esim/mock-provider";
import type { ESIMProvider } from "@/lib/esim/provider";

let registered = false;

/** A map of providerKey → ESIMProvider instance, for test/custom registration. */
const providerInstances = new Map<string, ESIMProvider>();

/**
 * Register a custom ESIM provider instance under a specific providerKey.
 * This is how tests register multiple distinct providers (e.g. "provider-a"
 * and "provider-b") to prove genuine multi-provider isolation.
 */
export function registerESIMProvider(providerKey: string, provider: ESIMProvider): void {
  providerInstances.set(providerKey, provider);
  // Create an adapter bound to THIS specific provider instance (not a singleton).
  registerAdapter(makeESIMFulfillmentAdapter(providerKey, provider));
}

/** Register default adapters + persistence handlers. Idempotent. */
export function ensureDefaultFulfillmentRegistered(): void {
  if (registered) return;
  registered = true;

  // Register the default mock provider under "mock".
  // This is the only place getESIMProvider()-style singleton is used —
  // it's a bootstrap default, NOT the purchase-path resolution mechanism.
  // The purchase path uses Supplier.providerKey → getAdapter() → this adapter.
  registerESIMProvider("mock", mockESIMProvider);

  // Register the persistence handler for ESIM products.
  registerPersistenceHandler(ESIMFulfillmentPersistence);
}

// Register on import.
ensureDefaultFulfillmentRegistered();
