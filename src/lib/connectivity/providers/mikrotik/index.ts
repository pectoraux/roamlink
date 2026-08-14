/**
 * Phase 2C.3 / 2C.3.1 — MikroTik provider registration.
 *
 * Registers the MikroTik connectivity adapter with the provider registry.
 * The adapter receives its MikroTikProviderClient via dependency injection.
 *
 * Development/testing: uses MockMikroTikProviderClient (deterministic).
 * Production (future): would use RouterOSProviderClient with real credentials.
 *
 * The adapter MUST NOT import a specific client implementation — it receives
 * the client through its constructor.
 */

import { registerConnectivityProvider } from "../../registry";
import { MikroTikConnectivityAdapter } from "./adapter";
import { mockMikroTikProviderClient } from "./mock-client";

// Register the MikroTik adapter with an injected provider client.
// In production, this would be:
//   new MikroTikConnectivityAdapter(routerOSProviderClient)
// For development/testing, we inject the mock client.
const mikrotikAdapter = new MikroTikConnectivityAdapter(mockMikroTikProviderClient);
registerConnectivityProvider(mikrotikAdapter);
