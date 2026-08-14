/**
 * Phase 2C.2 / 2C.2.1 — Connectivity Provider Adapter Registry
 *
 * The registry resolves provider adapters by their providerType string.
 * The entitlement kernel and reconciliation worker use this registry to
 * call the correct adapter without knowing which specific provider is
 * being used.
 *
 * Phase 2C.2.1 — REGISTRY IS CODE, NOT CUSTOMER STATE:
 *   The registry is an in-process adapter catalog. It MUST NOT be the source
 *   of truth for which provider owns a customer resource. Persisted
 *   ProviderResourceBinding.providerType remains authoritative.
 *
 *   Runtime flow:
 *     ProviderResourceBinding.providerType (PostgreSQL)
 *       → requireConnectivityProvider(providerType)
 *       → in-process adapter
 *
 *   The registry state may disappear on serverless cold start. Application
 *   startup must register required built-in adapters. Customer binding state
 *   survives independently in PostgreSQL. A cold start cannot change provider
 *   ownership.
 *
 * Phase 2C.2.1 — SAFE REGISTRATION SEMANTICS:
 *   Production registration is NOT silently replaceable:
 *     - If providerType is not registered → register (success)
 *     - If the exact same adapter is already registered → idempotent success
 *     - If a DIFFERENT adapter is already registered → throw configuration error
 *
 *   Test/development-only replacement is available via replaceConnectivityProvider().
 */

import type { ConnectivityProviderAdapter } from "./adapter";
import { mockConnectivityProvider } from "./mock-provider";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Provider Type Normalization
// ---------------------------------------------------------------------------

/**
 * Phase 2C.2.1: Canonical provider type normalization.
 *
 * Rules:
 *   - trim whitespace
 *   - lowercase
 *   - reject empty
 *
 * This function is used for register, get, require, isRegistered, and
 * persisted binding resolution. It ensures that "MikroTik", "mikrotik",
 * and "  mikrotik  " all resolve to the same adapter.
 *
 * @throws Error if the normalized type is empty
 */
export function normalizeProviderType(providerType: string): string {
  if (typeof providerType !== "string") {
    throw new Error(`providerType must be a string, got ${typeof providerType}`);
  }
  const normalized = providerType.trim().toLowerCase();
  if (!normalized) {
    throw new Error("providerType cannot be empty or whitespace-only");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ConnectivityProviderAdapter>();

/**
 * Phase 2C.2.1: Register a connectivity provider adapter.
 *
 * Safe registration semantics:
 *   - If providerType is not registered → register (success)
 *   - If the exact same adapter is already registered → idempotent success
 *   - If a DIFFERENT adapter is already registered → throw configuration error
 *
 * This prevents silently replacing production adapters, which could be
 * dangerous for provider infrastructure.
 *
 * @param adapter The adapter to register
 * @throws Error if providerType is empty or a different adapter is already registered
 */
export function registerConnectivityProvider(adapter: ConnectivityProviderAdapter): void {
  const key = normalizeProviderType(adapter.providerType);
  const existing = registry.get(key);

  if (existing) {
    if (existing === adapter) {
      // Idempotent — same adapter already registered
      logger.info("connectivity.adapter_registered_idempotent", { providerType: key });
      return;
    }
    // Different adapter already registered — configuration error
    throw new Error(
      `Provider type "${key}" is already registered with a different adapter ` +
      `("${existing.label}"). Cannot replace "${existing.label}" with "${adapter.label}". ` +
      `Use replaceConnectivityProvider() for explicit test/development replacement.`,
    );
  }

  registry.set(key, adapter);
  logger.info("connectivity.adapter_registered", { providerType: key, label: adapter.label });
}

/**
 * Phase 2C.2.1: Replace a connectivity provider adapter.
 *
 * This is a TEST/DEVELOPMENT-ONLY function. It explicitly replaces an
 * existing adapter with a new one. In production, provider adapters should
 * be registered once at startup and never replaced.
 *
 * @param adapter The new adapter to register
 */
export function replaceConnectivityProvider(adapter: ConnectivityProviderAdapter): void {
  const key = normalizeProviderType(adapter.providerType);
  const previous = registry.get(key);
  registry.set(key, adapter);
  if (previous) {
    logger.warn("connectivity.adapter_replaced", {
      providerType: key,
      previousLabel: previous.label,
      newLabel: adapter.label,
      message: "Adapter replaced — this should only happen in test/development",
    });
  } else {
    logger.info("connectivity.adapter_registered", { providerType: key, label: adapter.label });
  }
}

/**
 * Phase 2C.2.1: Unregister a connectivity provider adapter.
 *
 * TEST/DEVELOPMENT-ONLY. Removes an adapter from the registry.
 *
 * @param providerType The provider type to unregister
 */
export function unregisterConnectivityProvider(providerType: string): void {
  const key = normalizeProviderType(providerType);
  registry.delete(key);
  logger.info("connectivity.adapter_unregistered", { providerType: key });
}

/**
 * Get a connectivity provider adapter by providerType.
 * @param providerType The provider type string (e.g., "mock", "mikrotik", "esim")
 * @returns The adapter, or undefined if not registered
 */
export function getConnectivityProvider(providerType: string): ConnectivityProviderAdapter | undefined {
  const key = normalizeProviderType(providerType);
  return registry.get(key);
}

/**
 * Get a connectivity provider adapter by providerType.
 * @throws Error if the adapter is not registered
 */
export function requireConnectivityProvider(providerType: string): ConnectivityProviderAdapter {
  const key = normalizeProviderType(providerType);
  const adapter = registry.get(key);
  if (!adapter) {
    throw new Error(
      `No connectivity provider adapter registered for providerType "${key}". ` +
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
  const key = normalizeProviderType(providerType);
  return registry.has(key);
}

// ---------------------------------------------------------------------------
// Durable Binding Resolution
// ---------------------------------------------------------------------------

/**
 * Phase 2C.2.1: Resolve the adapter for a persisted ProviderResourceBinding.
 *
 * This is the ONLY correct way to resolve which adapter handles a binding.
 * It reads providerType from PostgreSQL (durable state) and resolves through
 * the in-process registry (code catalog).
 *
 * The registry is NEVER the source of truth for which provider owns a
 * customer resource. The persisted binding is.
 *
 * @param bindingId The ProviderResourceBinding ID
 * @returns The adapter for this binding
 * @throws Error if the binding doesn't exist or the provider is not registered
 */
export async function resolveBindingAdapter(bindingId: string): Promise<{
  adapter: ConnectivityProviderAdapter;
  binding: { id: string; providerType: string; status: string; providerResourceId: string | null };
}> {
  // Import db lazily to avoid circular dependency at module load time
  const { db } = await import("@/lib/db");

  const binding = await db.providerResourceBinding.findUnique({
    where: { id: bindingId },
    select: {
      id: true,
      providerType: true,
      status: true,
      providerResourceId: true,
      entitlementId: true,
    },
  });

  if (!binding) {
    throw new Error(`ProviderResourceBinding not found: ${bindingId}`);
  }

  const adapter = requireConnectivityProvider(binding.providerType);

  return {
    adapter,
    binding: {
      id: binding.id,
      providerType: binding.providerType,
      status: binding.status,
      providerResourceId: binding.providerResourceId,
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-registration of the mock provider
// ---------------------------------------------------------------------------

// The mock provider is always available for development/testing.
// Real providers (MikroTik, eSIM, WiFi ISP) will be registered in Phase 2C.3+.
// This is safe because:
//   1. The mock provider is a singleton — registerConnectivityProvider is idempotent
//   2. On serverless cold start, this module is re-evaluated and the mock is re-registered
//   3. Customer binding state survives in PostgreSQL — a cold start cannot change provider ownership
registerConnectivityProvider(mockConnectivityProvider);
