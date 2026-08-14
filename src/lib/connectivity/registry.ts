/**
 * Phase 2C.2 — Connectivity Provider Adapter Registry
 *
 * The registry resolves provider adapters by their providerType string.
 * The entitlement kernel and reconciliation worker use this registry to
 * call the correct adapter without knowing which specific provider is
 * being used.
 *
 * The registry is generic enough for three fundamentally different provider
 * categories:
 *   - eSIM providers (airalo, direct eSIM suppliers)
 *   - Network appliance providers (MikroTik, RADIUS-based hotspots)
 *   - WiFi/ISP platforms (community WiFi, ISP APIs)
 *
 * The adapter contract is capability-oriented, not eSIM-oriented. Each
 * adapter implements the same interface regardless of the underlying
 * provider category.
 *
 * Registration is idempotent — registering the same providerType twice
 * overwrites the previous adapter. This allows hot-swapping adapters
 * in development.
 */

import type { ConnectivityProviderAdapter } from "./adapter";
import { mockConnectivityProvider } from "./mock-provider";
import { logger } from "@/lib/logger";

const registry = new Map<string, ConnectivityProviderAdapter>();

/**
 * Register a connectivity provider adapter.
 * @param adapter The adapter to register
 * @throws if adapter.providerType is empty
 */
export function registerConnectivityProvider(adapter: ConnectivityProviderAdapter): void {
  if (!adapter.providerType) {
    throw new Error("Adapter must have a non-empty providerType");
  }
  const key = adapter.providerType.toLowerCase();
  const previous = registry.get(key);
  registry.set(key, adapter);
  if (previous) {
    logger.info("connectivity.adapter_replaced", { providerType: adapter.providerType });
  } else {
    logger.info("connectivity.adapter_registered", { providerType: adapter.providerType, label: adapter.label });
  }
}

/**
 * Get a connectivity provider adapter by providerType.
 * @param providerType The provider type string (e.g., "mock", "mikrotik", "esim")
 * @returns The adapter, or undefined if not registered
 */
export function getConnectivityProvider(providerType: string): ConnectivityProviderAdapter | undefined {
  return registry.get(providerType.toLowerCase());
}

/**
 * Get a connectivity provider adapter by providerType.
 * @throws if the adapter is not registered
 */
export function requireConnectivityProvider(providerType: string): ConnectivityProviderAdapter {
  const adapter = getConnectivityProvider(providerType);
  if (!adapter) {
    throw new Error(
      `No connectivity provider adapter registered for providerType "${providerType}". ` +
      `Registered types: ${Array.from(registry.keys()).join(", ") || "none"}`,
    );
  }
  return adapter;
}

/**
 * List all registered provider types.
 */
export function listRegisteredProviderTypes(): string[] {
  return Array.from(registry.keys());
}

/**
 * Check if a provider type is registered.
 */
export function isProviderRegistered(providerType: string): boolean {
  return registry.has(providerType.toLowerCase());
}

// ---------------------------------------------------------------------------
// Auto-registration of the mock provider
// ---------------------------------------------------------------------------

// The mock provider is always available for development/testing.
// Real providers (MikroTik, eSIM, WiFi ISP) will be registered in Phase 2C.3+.
registerConnectivityProvider(mockConnectivityProvider);
