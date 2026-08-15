/**
 * Phase 2C.3 / 2C.3.1 / 2C.3.3 / 2C.3.4 — MikroTik provider registration.
 *
 * Registers the MikroTik connectivity adapter with the provider registry.
 * The adapter receives a MikroTikClientResolver (not a fixed client).
 *
 * Phase 2C.3.4 — FAIL-CLOSED RESOLUTION:
 *   The production resolver MUST NEVER fall back to a default client for
 *   an unknown providerInstanceId. If a client cannot be resolved for the
 *   specific instance, the operation FAILS CLOSED.
 *
 *   known configured instance → resolve specific client
 *   unknown instance          → typed provider-instance-not-configured error
 *   inactive instance         → reject
 *   invalid configuration     → reject
 *
 *   There is NO default provider instance. No silent fallback.
 *
 * Test/development: uses a mock client registry (registerMockClientForInstance).
 * Production (future Phase 2C.4): would create/cache RouterOSProviderClient
 * instances based on the provider instance configuration (endpoint URL,
 * credentials from secrets manager, etc.).
 */

import { registerConnectivityProvider } from "../../registry";
import { MikroTikConnectivityAdapter } from "./adapter";
import { MikroTikProviderError } from "./client";
import type { MikroTikClientResolver, MikroTikProviderClient } from "./client";

// ---------------------------------------------------------------------------
// Test-only mock client registry
// ---------------------------------------------------------------------------

/**
 * TEST-ONLY mock client registry.
 *
 * Maps providerInstanceId → MikroTikProviderClient for testing.
 * This is NOT used by the production resolver — it's a separate test
 * facility that tests can inject via a custom resolver.
 *
 * In production, the resolver would load ConnectivityProviderInstance
 * from PostgreSQL, resolve secrets via configurationKey, and construct
 * a real RouterOSProviderClient. That factory doesn't exist yet (Phase 2C.4).
 */
const mockClientRegistry = new Map<string, MikroTikProviderClient>();

/**
 * Register a specific mock client for a specific provider instance.
 * TEST-ONLY — allows tests to verify that binding A uses client A.
 */
export function registerMockClientForInstance(providerInstanceId: string, client: MikroTikProviderClient): void {
  mockClientRegistry.set(providerInstanceId, client);
}

/**
 * Clear all mock client registrations (test cleanup).
 * TEST-ONLY.
 */
export function clearMockClientRegistry(): void {
  mockClientRegistry.clear();
}

// ---------------------------------------------------------------------------
// Fail-closed client resolver
// ---------------------------------------------------------------------------

/**
 * Phase 2C.3.4: The production client resolver.
 *
 * This resolver is FAIL-CLOSED. It does NOT fall back to a default client.
 *
 * Resolution path:
 *   1. Check the test-only mock registry (if a client is registered for
 *      this instance, return it — this is how tests inject specific clients)
 *   2. If no client is registered → throw MikroTikProviderError(PERMANENT)
 *
 * In production (Phase 2C.4), step 1 would be replaced with:
 *   1. Load ConnectivityProviderInstance from PostgreSQL
 *   2. Verify instance.providerType === "mikrotik"
 *   3. Verify instance.status === "active"
 *   4. Resolve secrets via configurationKey
 *   5. Construct/cache RouterOSProviderClient
 *
 * But the fail-closed behavior remains: if the client cannot be resolved
 * for THIS SPECIFIC instance, the operation fails. No fallback.
 */
const failClosedResolver: MikroTikClientResolver = (input) => {
  // Check the test-only mock registry
  const registered = mockClientRegistry.get(input.providerInstanceId);
  if (registered) {
    return registered;
  }

  // Phase 2C.3.4: FAIL CLOSED — no default client fallback.
  // In production, this is where the real client factory would run.
  // For now, any instance not explicitly registered in the test registry
  // is "not configured" and must fail.
  throw new MikroTikProviderError(
    "PERMANENT",
    `Provider instance "${input.providerInstanceId}" has no configured MikroTik client. ` +
    `No fallback to a default client — each infrastructure instance must be explicitly configured. ` +
    `(In production, this would load the instance configuration and create a RouterOSProviderClient.)`,
  );
};

// Register the MikroTik adapter with the fail-closed resolver.
const mikrotikAdapter = new MikroTikConnectivityAdapter(failClosedResolver);
registerConnectivityProvider(mikrotikAdapter);
