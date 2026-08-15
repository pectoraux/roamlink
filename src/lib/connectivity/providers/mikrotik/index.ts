/**
 * Phase 2C.3 / 2C.3.1 / 2C.3.3 — MikroTik provider registration.
 *
 * Registers the MikroTik connectivity adapter with the provider registry.
 * The adapter receives a MikroTikClientResolver (not a fixed client).
 *
 * The resolver maps providerInstanceId → MikroTikProviderClient.
 * This allows the SAME adapter class to operate against different MikroTik
 * routers using different clients.
 *
 * Development/testing: uses a mock client registry that returns
 * MockMikroTikProviderClient instances.
 * Production (future): would create/cache RouterOSProviderClient instances
 * based on the provider instance configuration (endpoint URL, credentials
 * from secrets manager, etc.).
 */

import { registerConnectivityProvider } from "../../registry";
import { MikroTikConnectivityAdapter } from "./adapter";
import { mockMikroTikProviderClient } from "./mock-client";
import type { MikroTikClientResolver } from "./client";

/**
 * Phase 2C.3.3: Mock client registry for development/testing.
 *
 * Maps providerInstanceId → MikroTikProviderClient.
 * In production, this would be a real client factory that creates
 * RouterOSProviderClient instances based on instance configuration.
 *
 * For testing, callers can register specific clients for specific instances
 * using registerMockClientForInstance().
 */
const mockClientRegistry = new Map<string, MikroTikProviderClient>();

/**
 * Register a specific mock client for a specific provider instance.
 * Test-only — allows tests to verify that binding A uses client A.
 */
export function registerMockClientForInstance(providerInstanceId: string, client: MikroTikProviderClient): void {
  mockClientRegistry.set(providerInstanceId, client);
}

/**
 * Clear all mock client registrations (test cleanup).
 */
export function clearMockClientRegistry(): void {
  mockClientRegistry.clear();
}

/**
 * The client resolver used by the registered MikroTik adapter.
 *
 * For each providerInstanceId:
 *   1. If a specific client is registered for that instance → use it
 *   2. Otherwise → fall back to the default mock client
 *
 * In production, this resolver would create RouterOSProviderClient instances
 * based on the provider instance configuration (endpoint, credentials, etc.).
 */
const defaultResolver: MikroTikClientResolver = (input) => {
  const registered = mockClientRegistry.get(input.providerInstanceId);
  if (registered) {
    return registered;
  }
  // Fall back to the default mock client (backward compatibility)
  return mockMikroTikProviderClient;
};

// Register the MikroTik adapter with the client resolver.
const mikrotikAdapter = new MikroTikConnectivityAdapter(defaultResolver);
registerConnectivityProvider(mikrotikAdapter);
