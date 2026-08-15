/**
 * Phase 2C.5 — eSIM Mock Client Registry + Production Resolver
 *
 * Mirrors the MikroTik client-factory pattern:
 *   - Test-only mock registry: registerMockEsimClientForInstance
 *   - Production async resolver: esimProductionAsyncResolver
 *   - FAIL-CLOSED: if no client is registered for the instance, throws
 */

import type { EsimProviderClient, AsyncEsimClientResolver } from "./client";
import { EsimProviderError } from "./client";
import { EsimSupplierClient } from "./esim-client";
import { FetchEsimTransport, MockEsimTransport } from "./transport";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Test-only mock registry (mirrors MikroTik's mock client registry)
// ---------------------------------------------------------------------------

const mockClientRegistry = new Map<string, EsimProviderClient>();

export function registerMockEsimClientForInstance(
  providerInstanceId: string,
  client: EsimProviderClient,
): void {
  mockClientRegistry.set(providerInstanceId, client);
}

export function clearEsimMockClientRegistry(): void {
  mockClientRegistry.clear();
}

// ---------------------------------------------------------------------------
// Production async resolver (mirrors MikroTik's productionAsyncResolver)
// ---------------------------------------------------------------------------

/**
 * Resolve the eSIM client for a provider instance.
 *
 * 1. Check the test-only mock registry first (for tests).
 * 2. If no mock is registered, attempt to construct a real client from
 *    environment variables (ESIM_SUPPLIER_ENDPOINT + ESIM_SUPPLIER_API_KEY).
 * 3. If neither resolves, FAIL CLOSED.
 */
export const esimProductionAsyncResolver: AsyncEsimClientResolver = async (input) => {
  // Step 1: check mock registry
  const mockClient = mockClientRegistry.get(input.providerInstanceId);
  if (mockClient) {
    return mockClient;
  }

  // Step 2: attempt real client from env
  const endpoint = process.env.ESIM_SUPPLIER_ENDPOINT;
  const apiKey = process.env.ESIM_SUPPLIER_API_KEY;
  if (endpoint && apiKey) {
    const transport = new FetchEsimTransport({ endpoint, apiKey });
    return new EsimSupplierClient(transport, input.providerInstanceId);
  }

  // Step 3: fail closed
  logger.error("esim.client_resolution_failed", {
    providerInstanceId: input.providerInstanceId,
    message: "No mock client registered and no ESIM_SUPPLIER_ENDPOINT/ESIM_SUPPLIER_API_KEY env vars — FAILING CLOSED.",
  });
  throw new EsimProviderError(
    "PERMANENT",
    `No eSIM client configured for provider instance "${input.providerInstanceId}". ` +
    `Register a mock client for tests, or set ESIM_SUPPLIER_ENDPOINT + ESIM_SUPPLIER_API_KEY for production.`,
  );
};

// Re-export for tests
export { MockEsimTransport, FetchEsimTransport } from "./transport";
export { EsimSupplierClient } from "./esim-client";
