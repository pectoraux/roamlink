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
import type { MikroTikProviderClient, MikroTikResourceConfig } from "./client";
import { MikroTikProviderError } from "./client";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

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
  }
  // Unknown error — default to retryable (safer for transient issues)
  const errorMsg = err instanceof Error ? err.message : String(err);
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

  constructor(private readonly client: MikroTikProviderClient) {}

  async provision(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ProvisionResult> {
    try {
      // If the binding already has a providerResourceId, it's idempotent — return it.
      if (input.binding.providerResourceId) {
        const existing = await this.client.getResource(input.binding.providerResourceId);
        if (existing) {
          logger.info("mikrotik.provision_idempotent", {
            bindingId: input.binding.id,
            username: input.binding.providerResourceId,
          });
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
        logger.info("mikrotik.provision_recreate", { bindingId: input.binding.id });
      }

      const config = mapCapabilityToMikroTikConfig(input.entitlement, input.binding);
      const resource = await this.client.createResource(config);

      logger.info("mikrotik.provisioned", {
        bindingId: input.binding.id,
        username: resource.id,
        resourceType: resource.resourceType,
      });

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
      logger.error("mikrotik.provision_failed", {
        bindingId: input.binding.id,
        error: classified.error,
        classification: classified.status,
      });
      return {
        status: classified.status,
        error: classified.error,
      };
    }
  }

  async suspend(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (!input.binding.providerResourceId) {
      return { status: "failed_permanent", error: "No providerResourceId on binding" };
    }

    try {
      await this.client.suspendResource(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async resume(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (!input.binding.providerResourceId) {
      return { status: "failed_permanent", error: "No providerResourceId on binding" };
    }

    try {
      await this.client.resumeResource(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async release(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (!input.binding.providerResourceId) {
      // Already released — idempotent
      return { status: "success" };
    }

    try {
      await this.client.deleteResource(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async getUsage(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<UsageMetrics | undefined> {
    if (!input.binding.providerResourceId) return undefined;

    try {
      const usage = await this.client.getResourceUsage(input.binding.providerResourceId);
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
      const resource = await this.client.getResource(input.binding.providerResourceId);

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
