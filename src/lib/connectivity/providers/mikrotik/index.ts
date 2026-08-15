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
 * Phase 2C.3.4 — FAIL-CLOSED:
 *   If the client cannot be resolved for THIS SPECIFIC instance, the
 *   operation FAILS CLOSED. No fallback. No default client.
 */

import { registerConnectivityProvider } from "../../registry";
import { MikroTikConnectivityAdapter } from "./adapter";
import { productionAsyncResolver } from "./client-factory";

// Re-export test utilities (for backward compatibility)
export { registerMockClientForInstance, clearMockClientRegistry, clearClientCache } from "./client-factory";

// Register the MikroTik adapter with the production async resolver.
// The resolver:
//   1. Checks the test-only mock registry (for tests)
//   2. Falls through to the real client factory (for production)
//   3. Fails closed if neither resolves a client
const mikrotikAdapter = new MikroTikConnectivityAdapter(productionAsyncResolver);
registerConnectivityProvider(mikrotikAdapter);
