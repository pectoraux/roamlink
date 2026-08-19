/**
 * Phase 2C.3 / 2C.3.1 / 2C.3.3 / 2C.3.4 / 2C.4 — MikroTik provider registration.
 *
 * Registers the MikroTik connectivity adapter with the provider registry.
 * The adapter receives an async client resolver (not a fixed client).
 *
 * Phase 2C.4 — REAL ROUTEROS CLIENT:
 *   The production resolver now uses the real client factory:
 *     providerInstanceId → ConnectivityProviderInstance → configurationKey
 *     → secret resolver → RouterOSProviderClient → FetchRouterOSTransport
 *
 *   The test-only mock registry is checked first (for backward compat with
 *   existing tests). If no mock is registered, the real factory runs.
 *
 * Phase 2C.3.4 — FAIL CLOSED:
 *   If the client cannot be resolved for THIS SPECIFIC instance, the
 *   operation FAILS CLOSED. No fallback. No default client.
 *
 *   Concretely: the productionAsyncResolver throws a plain Error whose message
 *   contains the substrings "no configured MikroTik client", "No fallback to a default client",
 *   and "each infrastructure instance must be explicitly configured", followed by the original cause.
 *   The adapter's classifyError() inspects the message and classifies these as failed_permanent.
 *   This is documented in the Phase 2C.3.4 fail-closed audit (worklog 12.4.2a-fix).
 *
 *   The mock registry itself is NEVER used as a fallback in production —
 *   it is checked first ONLY for test compatibility. In production, no
 *   mocks are registered, so the real factory is always invoked.
 */

import { registerConnectivityProvider } from "../../registry";
import { MikroTikConnectivityAdapter } from "./adapter";
import {
  productionAsyncResolver,
  registerMockClientForInstance as _registerMockClient,
  clearMockClientRegistry as _clearMockRegistry,
  clearClientCache as _clearClientCache,
  mockClientRegistry,
} from "./client-factory";
import type { MikroTikProviderClient } from "./client";

// ---------------------------------------------------------------------------
// Test-only mock client registry (re-exported via wrapper functions for
// backward compatibility with existing tests). The registry itself lives in
// client-factory.ts and is shared with productionAsyncResolver so that a mock
// registered here is observable by the resolver.
//
// These wrapper function definitions are here so that static source-code
// checks (tests/phase2c33-client-resolution.test.ts) can verify that the
// functions are exported from this module's public surface.
// ---------------------------------------------------------------------------

/**
 * Register a mock MikroTikProviderClient for a specific provider instance ID.
 * TEST-ONLY — production code MUST NOT register mocks.
 */
export function registerMockClientForInstance(providerInstanceId: string, client: MikroTikProviderClient): void {
  _registerMockClient(providerInstanceId, client);
}

/**
 * Clear all mock client registrations. TEST-ONLY.
 */
export function clearMockClientRegistry(): void {
  _clearMockRegistry();
}

/**
 * Clear the production client cache (transport-level cache). Useful for tests
 * that need to verify credential rotation behavior.
 */
export function clearClientCache(): void {
  _clearClientCache();
}

// Register the MikroTik adapter with the production async resolver.
// The resolver:
//   1. Checks the test-only mock registry (for tests)
//   2. Falls through to the real client factory (for production)
//   3. FAILS CLOSED if neither resolves a client — see the comment block at
//      the top of this file. There is NO default client. Each infrastructure
//      instance must be explicitly configured.
const mikrotikAdapter = new MikroTikConnectivityAdapter(productionAsyncResolver);
registerConnectivityProvider(mikrotikAdapter);

// Export the pre-instantiated adapter instance for direct testing.
export { mikrotikAdapter };
