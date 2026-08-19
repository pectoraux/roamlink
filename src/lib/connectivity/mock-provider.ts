/**
 * Phase 2C.1 — Mock Connectivity Provider Adapter
 *
 * A no-op adapter used in development/testing. Simulates a connectivity
 * provider that creates resources synchronously.
 */

import type {
  ConnectivityProviderAdapter,
  ProvisionResult,
  ActionResult,
  UsageMetrics,
  ReconciliationResult,
  ConnectivityEntitlementInput,
  ProviderResourceBindingInput,
} from "./adapter";
import { logger } from "@/lib/logger";

const mockResources = new Map<string, { active: boolean; createdAt: Date }>();

export class MockConnectivityProvider implements ConnectivityProviderAdapter {
  readonly providerType = "mock";
  readonly label = "Mock Connectivity Provider (Development)";

  async provision(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ProvisionResult> {
    const bindingId = input.binding.id;

    if (input.binding.providerResourceId) {
      logger.info("mock.connectivity.provision_idempotent", { bindingId, providerResourceId: input.binding.providerResourceId });
      return {
        status: "success",
        providerResourceId: input.binding.providerResourceId,
        providerMetadata: input.binding.providerMetadata ?? {},
      };
    }

    const providerResourceId = `mock-resource-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    mockResources.set(providerResourceId, { active: true, createdAt: new Date() });

    logger.info("mock.connectivity.provisioned", { bindingId, providerResourceId, entitlementId: input.entitlement.id });

    return {
      status: "success",
      providerResourceId,
      providerMetadata: { mock: true, createdAt: new Date().toISOString() },
    };
  }

  async suspend(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (input.binding.providerResourceId) {
      const resource = mockResources.get(input.binding.providerResourceId);
      if (resource) resource.active = false;
    }
    logger.info("mock.connectivity.suspended", { bindingId: input.binding.id });
    return { status: "success" };
  }

  async resume(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (input.binding.providerResourceId) {
      const resource = mockResources.get(input.binding.providerResourceId);
      if (resource) resource.active = true;
    }
    logger.info("mock.connectivity.resumed", { bindingId: input.binding.id });
    return { status: "success" };
  }

  async release(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    if (input.binding.providerResourceId) {
      mockResources.delete(input.binding.providerResourceId);
    }
    logger.info("mock.connectivity.released", { bindingId: input.binding.id });
    return { status: "success" };
  }

  async getUsage(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<UsageMetrics | undefined> {
    if (!input.binding.providerResourceId) return undefined;
    const resource = mockResources.get(input.binding.providerResourceId);
    if (!resource) return undefined;
    return {
      downloadBytes: Math.floor(Math.random() * 1_000_000_000),
      uploadBytes: Math.floor(Math.random() * 100_000_000),
      totalBytes: Math.floor(Math.random() * 1_100_000_000),
      currentDownloadMbps: resource.active ? 50 : 0,
      currentUploadMbps: resource.active ? 10 : 0,
      sessionDurationSeconds: Math.floor((Date.now() - resource.createdAt.getTime()) / 1000),
      isActive: resource.active,
      measuredAt: new Date(),
    };
  }

  async reconcile(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ReconciliationResult> {
    const bindingId = input.binding.id;
    const providerResourceId = input.binding.providerResourceId;

    if (!providerResourceId) {
      // No provider resource — binding hasn't been provisioned yet
      logger.info("mock.connectivity.reconcile_no_resource", { bindingId });
      return {
        status: "in_sync",
        observedState: "not_found",
        details: "No providerResourceId on binding — not yet provisioned",
      };
    }

    const resource = mockResources.get(providerResourceId);
    if (!resource) {
      // Resource was deleted at the provider (e.g., manual cleanup)
      logger.warn("mock.connectivity.reconcile_missing", { bindingId, providerResourceId });
      return {
        status: "resource_missing",
        observedState: "not_found",
        recommendedBindingState: "FAILED",
        details: "Provider resource no longer exists — binding should transition to FAILED",
      };
    }

    // Check if the resource state matches the binding state
    const bindingStatus = input.binding.status;
    if (resource.active && (bindingStatus === "BOUND" || bindingStatus === "PROVISIONING")) {
      return {
        status: "in_sync",
        observedState: "active",
        details: "Provider resource is active and matches binding state",
      };
    }

    if (!resource.active && bindingStatus === "BOUND") {
      // Resource is inactive but binding thinks it's BOUND — drift
      logger.warn("mock.connectivity.reconcile_drift", { bindingId, providerResourceId, bindingStatus, resourceActive: resource.active });
      return {
        status: "drift_detected",
        observedState: "inactive",
        recommendedBindingState: "DEGRADED",
        details: "Provider resource is inactive but binding is BOUND — recommend DEGRADED",
      };
    }

    if (!resource.active && bindingStatus === "DEGRADED") {
      return {
        status: "in_sync",
        observedState: "inactive",
        details: "Provider resource is inactive and binding is DEGRADED — states match",
      };
    }

    // Default: in sync
    return {
      status: "in_sync",
      observedState: resource.active ? "active" : "inactive",
      details: "Provider resource state matches binding state",
    };
  }
}

export const mockConnectivityProvider = new MockConnectivityProvider();
