/**
 * Phase 2C.3 — MikroTik provider registration.
 *
 * Registers the MikroTik connectivity adapter with the provider registry.
 * This is called at application startup (module load).
 *
 * The adapter uses the mock provider client by default for development/testing.
 * When real RouterOS credentials are configured (MIKROTIK_API_URL, etc.),
 * a real provider client would be used instead.
 */

import { registerConnectivityProvider } from "../../registry";
import { mikrotikConnectivityAdapter } from "./adapter";

// Register the MikroTik adapter with the provider registry.
// This is idempotent — if already registered with the same adapter, it's a no-op.
registerConnectivityProvider(mikrotikConnectivityAdapter);
