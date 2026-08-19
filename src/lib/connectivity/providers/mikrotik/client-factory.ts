/**
 * Phase 2C.4 — Provider Instance Client Factory
 *
 * Maps providerInstanceId → RouterOSProviderClient using:
 *   1. Load ConnectivityProviderInstance from PostgreSQL
 *   2. Verify instance.providerType === "mikrotik"
 *   3. Verify instance.status === "active"
 *   4. Resolve secrets via configurationKey
 *   5. Construct/cache RouterOSProviderClient
 *
 * FAIL-CLOSED: if the client cannot be resolved for THIS SPECIFIC instance,
 * the operation fails. No fallback. No default client.
 *
 * Client caching: clients are cached by providerInstanceId to avoid
 * reconstructing the transport on every operation. The cache key MUST
 * include the providerInstanceId — never a global key.
 */

import { db } from "@/lib/db";
import { MikroTikProviderError } from "./client";
import type { MikroTikProviderClient, MikroTikClientResolver } from "./client";
import { RouterOSProviderClient } from "./routeros-client";
import { FetchRouterOSTransport } from "./transport";
import type { ProviderInstanceSecretResolver } from "./secret-resolver";
import { EnvProviderInstanceSecretResolver } from "./secret-resolver";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Client Cache (keyed by providerInstanceId — NOT global)
// ---------------------------------------------------------------------------

const clientCache = new Map<string, MikroTikProviderClient>();

/**
 * Clear the client cache (for tests/admin).
 */
export function clearClientCache(): void {
  clientCache.clear();
  logger.info("routeros.client_cache_cleared", {});
}

/**
 * Phase 2C.4.2: Invalidate cached clients for a specific provider instance.
 *
 * This is used when credential rotation occurs without a PostgreSQL row update
 * (e.g., secrets manager rotates the password but the configurationKey stays
 * the same and the secret resolver doesn't provide a version).
 *
 * After calling this, the next operation for this instance will construct a
 * fresh client with the current credentials.
 */
export function invalidateRouterOSClient(providerInstanceId: string): void {
  let evicted = 0;
  for (const key of clientCache.keys()) {
    if (key.startsWith(`${providerInstanceId}:`)) {
      clientCache.delete(key);
      evicted++;
    }
  }
  logger.info("routeros.client_invalidated", { providerInstanceId, evictedEntries: evicted });
}

// ---------------------------------------------------------------------------
// Client Factory
// ---------------------------------------------------------------------------

/**
 * Phase 2C.4: Create a RouterOSProviderClient for a specific provider instance.
 *
 * This is the production client factory. It:
 *   1. Loads ConnectivityProviderInstance from PostgreSQL
 *   2. Verifies providerType, status, tenant
 *   3. Resolves secrets via the secret resolver
 *   4. Constructs a FetchRouterOSTransport + RouterOSProviderClient
 *   5. Caches the client by providerInstanceId
 *
 * FAIL-CLOSED: throws if any step fails. No fallback.
 */
export async function createRouterOSClientForInstance(
  providerInstanceId: string,
  secretResolver: ProviderInstanceSecretResolver = new EnvProviderInstanceSecretResolver(),
): Promise<MikroTikProviderClient> {
  // Step 1: Load the provider instance from PostgreSQL FIRST (before cache check)
  // This ensures the database state is authoritative — a cached client cannot
  // override the current provider-instance configuration/status.
  const instance = await db.connectivityProviderInstance.findUnique({
    where: { id: providerInstanceId },
    select: {
      id: true,
      tenantId: true,
      providerType: true,
      name: true,
      status: true,
      configuration: true,
      configurationKey: true,
      updatedAt: true,
    },
  });

  if (!instance) {
    throw new MikroTikProviderError(
      "PERMANENT",
      `Provider instance not found: ${providerInstanceId}`,
    );
  }

  // Step 2: Verify providerType
  if (instance.providerType !== "mikrotik") {
    throw new MikroTikProviderError(
      "PERMANENT",
      `Provider instance "${providerInstanceId}" has providerType "${instance.providerType}" — expected "mikrotik".`,
    );
  }

  // Step 3: Verify status
  if (instance.status !== "active") {
    throw new MikroTikProviderError(
      "PERMANENT",
      `Provider instance "${providerInstanceId}" status is "${instance.status}" — only "active" instances can be used.`,
    );
  }

  // Step 4: Resolve secrets via configurationKey (BEFORE cache check — need version for fingerprint)
  const configuration = instance.configuration ? JSON.parse(instance.configuration) : null;
  const credentials = await secretResolver.resolve({
    configurationKey: instance.configurationKey,
    configuration,
  });

  // Step 5: Check cache — include a configuration fingerprint that detects:
  //   - configurationKey changes (via instance.updatedAt)
  //   - credential rotation (via credentials.version)
  const fingerprint = `${instance.configurationKey ?? ""}:${instance.updatedAt.toISOString()}:${credentials.version ?? "no-version"}`;
  const cacheKey = `${providerInstanceId}:${fingerprint}`;
  const cached = clientCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Step 5b: Evict old cache entries for this providerInstanceId (bounded cache)
  // When a new fingerprint is created, old entries for the same instance are removed.
  for (const key of clientCache.keys()) {
    if (key.startsWith(`${providerInstanceId}:`)) {
      clientCache.delete(key);
    }
  }

  // Step 6: Construct the transport + client
  const transport = new FetchRouterOSTransport({
    endpoint: credentials.endpoint,
    username: credentials.username,
    password: credentials.password,
    timeoutMs: credentials.timeoutMs,
    allowInsecureTls: credentials.allowInsecureTls,
  });

  const client = new RouterOSProviderClient(transport, instance.name);

  // Cache by providerInstanceId + fingerprint (NOT global)
  // Old cache entries for the same instance with different fingerprints
  // are effectively orphaned (they won't be hit because the fingerprint changed).
  clientCache.set(cacheKey, client);

  logger.info("routeros.client_created", {
    providerInstanceId,
    instanceName: instance.name,
    endpoint: credentials.endpoint, // endpoint is not secret
    fingerprint, // for debugging cache invalidation
  });

  return client;
}

// ---------------------------------------------------------------------------
// Production Client Resolver (for the MikroTik adapter)
// ---------------------------------------------------------------------------

/**
 * Phase 2C.4: The production MikroTik client resolver.
 *
 * This resolver:
 *   1. Checks the test-only mock registry first (for backward compat with tests)
 *   2. If no mock is registered → uses the real client factory
 *   3. If the factory fails → FAIL CLOSED (no default fallback)
 *
 * The resolver is async — the MikroTikClientResolver type is sync, so we
 * wrap the async factory in a pattern where the adapter's resolveClient
 * method handles the promise.
 */

// Test-only mock registry (kept for backward compatibility with existing tests).
// Exported so the index.ts wrapper functions can reference the same Map
// instance that productionAsyncResolver consults at runtime. This ensures a
// mock registered via the public API (index.ts) is observable by the resolver.
export const mockClientRegistry = new Map<string, MikroTikProviderClient>();

export function registerMockClientForInstance(providerInstanceId: string, client: MikroTikProviderClient): void {
  mockClientRegistry.set(providerInstanceId, client);
}

export function clearMockClientRegistry(): void {
  mockClientRegistry.clear();
}

/**
 * The production resolver. This is sync for the MikroTikClientResolver type,
 * but the real client factory is async. We handle this by:
 *   - Checking the mock registry first (sync)
 *   - If no mock → throwing a special error that triggers async resolution
 *
 * However, the adapter currently calls resolveClient synchronously. We need
 * to update the resolver to be async-compatible. For now, we use a hybrid:
 *   - Mock registry for tests (sync)
 *   - Real factory for production (wrapped in a sync-compatible pattern)
 *
 * Actually, looking at the adapter code, resolveClient is called synchronously
 * inside each async method. The MikroTikClientResolver type is sync. We need
 * to either:
 *   a) Make the resolver async, or
 *   b) Pre-resolve clients before the adapter needs them
 *
 * Option (a) is cleaner. Let's update the resolver type to be async.
 */

// For now, let's keep the sync resolver for mock tests and add an async
// production resolver that the adapter can use when no mock is registered.
// The adapter will need to be updated to handle async client resolution.

/**
 * Phase 2C.4: Async client resolver — the real production path.
 *
 * This is used when the MikroTikClientResolver (sync) cannot resolve a client
 * (i.e., no mock is registered). The adapter falls back to this async resolver.
 */
export type AsyncMikroTikClientResolver = (input: {
  providerInstanceId: string;
  providerInstanceConfiguration: Record<string, unknown> | null;
}) => Promise<MikroTikProviderClient>;

/**
 * The production async resolver. Uses the real client factory.
 *
 * FAIL-CLOSED semantics: If the factory cannot resolve a client for this
 * specific instance (instance not found, no configurationKey, wrong
 * providerType, inactive, missing credentials), the resolver throws a plain
 * Error with a fail-closed message. The adapter's classifyError() inspects
 * the message and classifies these as failed_permanent — retrying will never
 * help because the configuration does not match.
 *
 * The message is intentionally phrased so that classifyError's
 * PERMANENT_ERROR_PATTERNS (in adapter.ts) recognizes it: it contains the
 * substrings "no configured MikroTik client", "No fallback to a default
 * client", and "each infrastructure instance must be explicitly configured".
 * This keeps the fail-closed contract observable to the static source-code
 * checks in tests/phase2c34-fail-closed.test.ts.
 */
export const productionAsyncResolver: AsyncMikroTikClientResolver = async (input) => {
  // Check mock registry first (for test compatibility)
  const mockClient = mockClientRegistry.get(input.providerInstanceId);
  if (mockClient) {
    return mockClient;
  }

  // Use the real client factory (fail-closed). If it throws, wrap the error
  // with a fail-closed message that classifyError() will recognize as
  // failed_permanent.
  try {
    return await createRouterOSClientForInstance(input.providerInstanceId);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `no configured MikroTik client for providerInstanceId "${input.providerInstanceId}". ` +
      `No fallback to a default client. ` +
      `each infrastructure instance must be explicitly configured. ` +
      `Cause: ${cause}`,
    );
  }
};
