/**
 * Phase 2C.3 — MikroTik Connectivity Adapter
 *
 * Implements the ConnectivityProviderAdapter contract for MikroTik
 * infrastructure (RouterOS hotspot, RADIUS, PPPoE).
 *
 * Architecture:
 *   ConnectivityProviderAdapter (generic contract)
 *     → MikroTikConnectivityAdapter (this file — translates contract to MikroTik ops)
 *       → MikroTikProviderClient (low-level RouterOS/RADIUS API)
 *
 * The adapter does NOT own financial state. It only manages infrastructure
 * resources via the provider client.
 *
 * Capability mapping (INTERNET → MikroTik config):
 *   downloadMbps → downloadRateLimitBps (Mbps * 1_000_000)
 *   uploadMbps   → uploadRateLimitBps
 *   monthlyQuotaBytes → dataQuotaBytes
 *
 * Error classification:
 *   MikroTikProviderError.RETRYABLE → ProvisionResult.failed_retryable
 *   MikroTikProviderError.PERMANENT → ProvisionResult.failed_permanent
 *   MikroTikProviderError.AUTHENTICATION → ProvisionResult.failed_permanent
 *   MikroTikProviderError.NOT_FOUND → reconcile() resource_missing
 *   MikroTikProviderError.CONFLICT → ProvisionResult.failed_permanent
 *   MikroTikProviderError.TIMEOUT → ProvisionResult.failed_retryable
 */

import type {
  ConnectivityProviderAdapter,
  ProvisionResult,
  ActionResult,
  UsageMetrics,
  ReconciliationResult,
  ConnectivityEntitlementInput,
  ProviderResourceBindingInput,
} from "../../adapter";
import type { MikroTikProviderClient, MikroTikResourceConfig, MikroTikClientResolver } from "./client";
import { MikroTikProviderError } from "./client";
import type { AsyncMikroTikClientResolver } from "./client-factory";
import type { ProviderCorrelationContext } from "../../../observability/provider-correlation";
import { withCorrelation } from "../../../observability/provider-correlation";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a CONFIGURATION error — these are PERMANENT and will
 * never succeed on retry. They originate from the client factory
 * (client-factory.ts) and the secret resolver (secret-resolver.ts) when:
 *   - The provider instance was not found in the database
 *   - The provider instance has no configurationKey (no credentials configured)
 *   - The provider instance has the wrong providerType
 *   - The provider instance is inactive / in maintenance
 *   - The secret resolver cannot resolve credentials
 *   - The async resolver cannot find a configured MikroTik client for this instance
 *
 * These are PLAIN Error objects (not MikroTikProviderError) — we classify by
 * message inspection.
 */
const PERMANENT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /not found/i,
  /no configurationKey/i,
  /cannot resolve/i,
  /\binactive\b/i,
  /maintenance/i,
  /expected mikrotik/i,
  /no configured MikroTik client/i,
  /No fallback to a default client/i,
  /each infrastructure instance must be explicitly configured/i,
  /cross-tenant/i,
  /provider type mismatch/i,
  /PERMANENT/i,
];

function classifyError(err: unknown): {
  status: "failed_retryable" | "failed_permanent";
  error: string;
} {
  if (err instanceof MikroTikProviderError) {
    const permanent = ["PERMANENT", "AUTHENTICATION", "CONFLICT"];
    const retryable = ["RETRYABLE", "TIMEOUT"];
    if (permanent.includes(err.errorType)) {
      return { status: "failed_permanent", error: err.message };
    }
    if (retryable.includes(err.errorType)) {
      return { status: "failed_retryable", error: err.message };
    }
    // NOT_FOUND is reconciled separately — treat as retryable here for safety.
    return { status: "failed_retryable", error: err.message };
  }

  // Plain Error from client factory / secret resolver / async resolver.
  // Configuration errors (missing configurationKey, inactive instance, unknown
  // providerType, instance not found, no configured client) are PERMANENT —
  // retrying will not help because the underlying configuration does not match.
  const errorMsg = err instanceof Error ? err.message : String(err);
  const isConfigurationError = PERMANENT_ERROR_PATTERNS.some((p) => p.test(errorMsg));
  if (isConfigurationError) {
    return { status: "failed_permanent", error: errorMsg };
  }

  // Unknown error — default to retryable. This is the SAFE default: a transient
  // network/DB error should not permanently fail a binding. The cost of a
  // needless retry is low; the cost of permanently failing a binding that
  // could have succeeded on retry is high. Documented in the Phase 2C.3.4
  // fail-closed audit (worklog 12.4.2a-fix).
  return { status: "failed_retryable", error: errorMsg };
}

// ---------------------------------------------------------------------------
// Capability Mapping
// ---------------------------------------------------------------------------

/**
 * Map a generic ConnectivityEntitlement capability set to a MikroTik resource config.
 *
 * The capability set is the JSON stored on the entitlement, e.g.:
 *   { downloadMbps: 50, uploadMbps: 10, monthlyQuotaBytes: 500000000000 }
 *
 * This mapping is OWNED by the adapter — the kernel never sees MikroTik concepts.
 */
function mapCapabilityToMikroTikConfig(
  entitlement: ConnectivityEntitlementInput,
  binding: ProviderResourceBindingInput,
): MikroTikResourceConfig {
  const caps = entitlement.capabilitySet;
  const downloadMbps = (caps.downloadMbps as number) ?? 0;
  const uploadMbps = (caps.uploadMbps as number) ?? 0;
  const monthlyQuotaBytes = (caps.monthlyQuotaBytes as number) ?? 0;

  // Generate a deterministic username from the entitlement + binding IDs.
  // This ensures idempotency: the same binding always gets the same username.
  const username = `rl-${binding.id.slice(-12)}`;
  const password = `pw-${entitlement.id.slice(-12)}`;

  // Determine resource type from binding.resourceType, default to hotspot_user
  const resourceType = binding.resourceType ?? "hotspot_user";

  return {
    resourceType,
    username,
    password,
    downloadRateLimitBps: downloadMbps > 0 ? downloadMbps * 1_000_000 : 0,
    uploadRateLimitBps: uploadMbps > 0 ? uploadMbps * 1_000_000 : 0,
    dataQuotaBytes: monthlyQuotaBytes > 0 ? monthlyQuotaBytes : 0,
  };
}

// ---------------------------------------------------------------------------
// MikroTik Connectivity Adapter
// ---------------------------------------------------------------------------

export class MikroTikConnectivityAdapter implements ConnectivityProviderAdapter {
  readonly providerType = "mikrotik";
  readonly label = "MikroTik Connectivity Provider";

  /**
   * Phase 2C.3.3 / 2C.3.4 / 2C.4: The adapter receives a client RESOLVER, not a fixed client.
   *
   * The resolver maps providerInstanceId → MikroTikProviderClient.
   * This allows the SAME adapter class to operate against different MikroTik
   * routers using different clients.
   *
   * Phase 2C.3.4: There is NO default client. If providerInstanceId is null
   * or the resolver cannot find a client for the instance, the operation
   * FAILS CLOSED. No backward-compat fallback to a default infrastructure.
   *
   * Phase 2C.4: The resolver may be sync (for mock tests) or async (for
   * the real RouterOS client factory). The adapter handles both.
   *
   * Backward compatibility (Phase 2C.3.1 tests): The constructor also accepts
   * a plain MikroTikProviderClient instance — it is wrapped internally as a
   * constant resolver that returns the same client for every binding. This
   * supports the original test API (e.g. `new MikroTikConnectivityAdapter(mockClient)`).
   * The production path uses the async resolver via the productionAsyncResolver
   * in client-factory.ts.
   */
  constructor(
    private readonly clientResolver: MikroTikClientResolver | AsyncMikroTikClientResolver | MikroTikProviderClient,
  ) {
    // If a plain client instance was passed (backward-compat with 2C.3.1 tests),
    // wrap it as a constant resolver. Detection: a MikroTikProviderClient has
    // a `createResource` method, while resolvers are functions.
    if (typeof clientResolver !== "function" && clientResolver && typeof (clientResolver as MikroTikProviderClient).createResource === "function") {
      const fixedClient = clientResolver as MikroTikProviderClient;
      this.clientResolver = (() => fixedClient) as unknown as MikroTikClientResolver;
    }
  }

  /**
   * Phase 2C.3.3 / 2C.4: Resolve the correct provider client for this binding.
   * Uses the binding's providerInstanceId to select the infrastructure instance.
   * Supports both sync and async resolvers.
   *
   * For backward compatibility (Phase 2C.3.1 tests that inject a fixed client
   * directly via the constructor), if the resolver is a wrapped constant
   * resolver (i.e., returns the same client regardless of input), a missing
   * providerInstanceId is tolerated — the fixed client is returned.
   *
   * For the production async resolver (productionAsyncResolver), a missing
   * providerInstanceId would cause the factory to fail; the factory's own
   * fail-closed logic surfaces that as a PERMANENT error.
   */
  private async resolveClient(binding: ProviderResourceBindingInput): Promise<MikroTikProviderClient> {
    const instanceId = binding.providerInstanceId;
    // If no providerInstanceId, only proceed if the resolver is a wrapped
    // constant client (backward compat). Detect this by checking if the
    // resolver is the wrapped arrow function we created in the constructor.
    // For real resolvers (function refs), throw PERMANENT — a binding without
    // a providerInstanceId cannot be resolved in production.
    if (!instanceId && typeof this.clientResolver === "function") {
      // Try invoking the resolver with an empty instanceId; if it's a wrapped
      // constant client, it returns the fixed client. If it's a real resolver,
      // it will throw — and the throw will be classified below.
      // We don't pre-emptively throw — let the resolver decide.
    }
    const result = this.clientResolver({
      providerInstanceId: instanceId ?? "",
      providerInstanceConfiguration: binding.providerInstanceConfiguration,
    });
    // Handle both sync and async resolvers
    return result instanceof Promise ? result : Promise.resolve(result);
  }

  async provision(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
    correlation?: ProviderCorrelationContext;
  }): Promise<ProvisionResult> {
    const ctx = input.correlation ?? {};
    try {
      const client = await this.resolveClient(input.binding);
      // If the binding already has a providerResourceId, it's idempotent — return it.
      if (input.binding.providerResourceId) {
        const existing = await client.getResource(input.binding.providerResourceId);
        if (existing) {
          logger.info("mikrotik.provision_idempotent", withCorrelation(ctx, {
            bindingId: input.binding.id,
            username: input.binding.providerResourceId,
          }));
          return {
            status: "success",
            providerResourceId: existing.id,
            providerMetadata: {
              resourceType: existing.resourceType,
              isActive: existing.isActive,
              downloadRateLimitBps: existing.downloadRateLimitBps,
              uploadRateLimitBps: existing.uploadRateLimitBps,
            },
          };
        }
        // Resource was deleted at the provider — re-create
        logger.info("mikrotik.provision_recreate", withCorrelation(ctx, { bindingId: input.binding.id }));
      }

      const config = mapCapabilityToMikroTikConfig(input.entitlement, input.binding);
      const resource = await client.createResource(config);

      logger.info("mikrotik.provisioned", withCorrelation(ctx, {
        bindingId: input.binding.id,
        username: resource.id,
        resourceType: resource.resourceType,
      }));

      return {
        status: "success",
        providerResourceId: resource.id,
        providerMetadata: {
          resourceType: resource.resourceType,
          isActive: resource.isActive,
          downloadRateLimitBps: resource.downloadRateLimitBps,
          uploadRateLimitBps: resource.uploadRateLimitBps,
        },
      };
    } catch (err) {
      const classified = classifyError(err);
      logger.error("mikrotik.provision_failed", withCorrelation(ctx, {
        bindingId: input.binding.id,
        error: classified.error,
        classification: classified.status,
      }));
      return {
        status: classified.status,
        error: classified.error,
      };
    }
  }

  async suspend(input: {
    correlation?: ProviderCorrelationContext;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (!input.binding.providerResourceId) {
      return { status: "failed_permanent", error: "No providerResourceId on binding" };
    }

    try {
      const client = await this.resolveClient(input.binding);
      await client.suspendResource(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async resume(input: {
    correlation?: ProviderCorrelationContext;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (!input.binding.providerResourceId) {
      return { status: "failed_permanent", error: "No providerResourceId on binding" };
    }

    try {
      const client = await this.resolveClient(input.binding);
      await client.resumeResource(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async release(input: {
    correlation?: ProviderCorrelationContext;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (!input.binding.providerResourceId) {
      // Already released — idempotent
      return { status: "success" };
    }

    try {
      const client = await this.resolveClient(input.binding);
      await client.deleteResource(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async getUsage(input: {
    correlation?: ProviderCorrelationContext;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<UsageMetrics | undefined> {
    if (!input.binding.providerResourceId) return undefined;

    try {
      const client = await this.resolveClient(input.binding);
      const usage = await client.getResourceUsage(input.binding.providerResourceId);
      if (!usage) return undefined;

      return {
        downloadBytes: usage.downloadBytes,
        uploadBytes: usage.uploadBytes,
        totalBytes: usage.downloadBytes + usage.uploadBytes,
        sessionDurationSeconds: usage.sessionDurationSeconds,
        isActive: usage.isActive,
        measuredAt: new Date(),
      };
    } catch (err) {
      const classified = classifyError(err);
      logger.warn("mikrotik.getUsage_failed", {
        bindingId: input.binding.id,
        error: classified.error,
      });
      return undefined;
    }
  }

  async reconcile(input: {
    correlation?: ProviderCorrelationContext;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ReconciliationResult> {
    if (!input.binding.providerResourceId) {
      // No resource provisioned yet — in sync (nothing to reconcile)
      return {
        status: "in_sync",
        observedState: "not_found",
        details: "No providerResourceId — not yet provisioned",
      };
    }

    try {
      const client = await this.resolveClient(input.binding);
      const resource = await client.getResource(input.binding.providerResourceId);

      if (!resource) {
        // Resource was deleted at the provider
        return {
          status: "resource_missing",
          observedState: "not_found",
          recommendedBindingState: "FAILED",
          details: "MikroTik resource no longer exists",
        };
      }

      // Check if the resource state matches the binding state
      const bindingStatus = input.binding.status;

      if (resource.isActive && (bindingStatus === "BOUND" || bindingStatus === "PROVISIONING")) {
        return {
          status: "in_sync",
          observedState: "active",
          details: "MikroTik resource is active and matches binding state",
        };
      }

      if (!resource.isActive && bindingStatus === "BOUND") {
        // Resource is suspended at provider but binding thinks it's BOUND — drift
        return {
          status: "drift_detected",
          observedState: "inactive",
          recommendedBindingState: "DEGRADED",
          details: "MikroTik resource is inactive but binding is BOUND",
        };
      }

      if (!resource.isActive && bindingStatus === "DEGRADED") {
        return {
          status: "in_sync",
          observedState: "inactive",
          details: "MikroTik resource is inactive and binding is DEGRADED — states match",
        };
      }

      // Default: in sync
      return {
        status: "in_sync",
        observedState: resource.isActive ? "active" : "inactive",
        details: "Resource state matches binding state",
      };
    } catch (err) {
      const classified = classifyError(err);
      return {
        status: classified.status,
        details: classified.error,
      };
    }
  }
}
