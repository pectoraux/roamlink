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
  ConnectivityEntitlementInput,
  ProviderResourceBindingInput,
} from "./adapter";
import { logger } from "@/lib/logger";

const mockResources = new Map<string, { active: boolean; createdAt: Date }>();

export class MockConnectivityProvider implements ConnectivityProviderAdapter {
  readonly providerType = "mock";
  readonly label = "Mock Connectivity Provider (Development)";

  async provision(input: {
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
}

export const mockConnectivityProvider = new MockConnectivityProvider();
