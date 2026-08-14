/**
 * Phase 2C.3 — Mock MikroTik Provider Client
 *
 * A deterministic test implementation that simulates RouterOS resources
 * and failures without requiring a real MikroTik router.
 *
 * Used for all CI/test environments. The real RouterOS REST API client
 * would implement the same MikroTikProviderClient interface.
 */

import type { MikroTikProviderClient, MikroTikResource, MikroTikResourceConfig } from "./client";
import { MikroTikProviderError } from "./client";
import { logger } from "@/lib/logger";

type MockResource = {
  id: string;
  resourceType: string;
  isActive: boolean;
  downloadRateLimitBps: number;
  uploadRateLimitBps: number;
  sessionTimeoutSeconds: number;
  dataQuotaBytes: number;
  createdAt: Date;
  downloadBytes: number;
  uploadBytes: number;
  sessionStartTime: Date;
};

const mockResources = new Map<string, MockResource>();

/**
 * Configuration for simulating failures in tests.
 */
let failureSimulation: {
  type: "none" | "retryable" | "permanent" | "auth" | "timeout";
  operations: string[]; // which operations to fail: ["create", "get", "suspend", "resume", "delete"]
} = { type: "none", operations: [] };

export function setMockFailureSimulation(config: {
  type: "none" | "retryable" | "permanent" | "auth" | "timeout";
  operations: string[];
}): void {
  failureSimulation = config;
  logger.info("mikrotik.mock.failure_simulation_set", config);
}

export function clearMockFailureSimulation(): void {
  failureSimulation = { type: "none", operations: [] };
}

function checkFailure(operation: string): void {
  if (failureSimulation.type === "none") return;
  if (!failureSimulation.operations.includes(operation)) return;

  switch (failureSimulation.type) {
    case "retryable":
      throw new MikroTikProviderError("RETRYABLE", `Simulated retryable failure on ${operation}`);
    case "permanent":
      throw new MikroTikProviderError("PERMANENT", `Simulated permanent failure on ${operation}`);
    case "auth":
      throw new MikroTikProviderError("AUTHENTICATION", `Simulated auth failure on ${operation}`);
    case "timeout":
      throw new MikroTikProviderError("TIMEOUT", `Simulated timeout on ${operation}`);
  }
}

export class MockMikroTikProviderClient implements MikroTikProviderClient {
  async createResource(config: MikroTikResourceConfig): Promise<MikroTikResource> {
    checkFailure("create");

    // Idempotent: if resource already exists, return it
    const existing = mockResources.get(config.username);
    if (existing) {
      logger.info("mikrotik.mock.create_idempotent", { username: config.username });
      return this.toResource(existing);
    }

    const resource: MockResource = {
      id: config.username,
      resourceType: config.resourceType,
      isActive: true,
      downloadRateLimitBps: config.downloadRateLimitBps ?? 0,
      uploadRateLimitBps: config.uploadRateLimitBps ?? 0,
      sessionTimeoutSeconds: config.sessionTimeoutSeconds ?? 0,
      dataQuotaBytes: config.dataQuotaBytes ?? 0,
      createdAt: new Date(),
      downloadBytes: 0,
      uploadBytes: 0,
      sessionStartTime: new Date(),
    };

    mockResources.set(config.username, resource);
    logger.info("mikrotik.mock.created", { username: config.username, resourceType: config.resourceType });

    return this.toResource(resource);
  }

  async getResource(username: string): Promise<MikroTikResource | null> {
    checkFailure("get");

    const resource = mockResources.get(username);
    if (!resource) return null;
    return this.toResource(resource);
  }

  async suspendResource(username: string): Promise<void> {
    checkFailure("suspend");

    const resource = mockResources.get(username);
    if (!resource) {
      throw new MikroTikProviderError("NOT_FOUND", `Resource not found: ${username}`);
    }
    resource.isActive = false;
    logger.info("mikrotik.mock.suspended", { username });
  }

  async resumeResource(username: string): Promise<void> {
    checkFailure("resume");

    const resource = mockResources.get(username);
    if (!resource) {
      throw new MikroTikProviderError("NOT_FOUND", `Resource not found: ${username}`);
    }
    resource.isActive = true;
    logger.info("mikrotik.mock.resumed", { username });
  }

  async deleteResource(username: string): Promise<void> {
    checkFailure("delete");

    // Idempotent: deleting non-existent is a no-op
    if (!mockResources.has(username)) {
      logger.info("mikrotik.mock.delete_idempotent", { username });
      return;
    }
    mockResources.delete(username);
    logger.info("mikrotik.mock.deleted", { username });
  }

  async getResourceUsage(username: string): Promise<{
    downloadBytes: number;
    uploadBytes: number;
    sessionDurationSeconds: number;
    isActive: boolean;
  } | null> {
    checkFailure("getUsage");

    const resource = mockResources.get(username);
    if (!resource) return null;

    // Simulate some usage
    const elapsed = Math.floor((Date.now() - resource.sessionStartTime.getTime()) / 1000);
    return {
      downloadBytes: resource.downloadBytes + Math.floor(Math.random() * 1_000_000_000),
      uploadBytes: resource.uploadBytes + Math.floor(Math.random() * 100_000_000),
      sessionDurationSeconds: elapsed,
      isActive: resource.isActive,
    };
  }

  private toResource(mock: MockResource): MikroTikResource {
    return {
      id: mock.id,
      resourceType: mock.resourceType,
      isActive: mock.isActive,
      downloadRateLimitBps: mock.downloadRateLimitBps,
      uploadRateLimitBps: mock.uploadRateLimitBps,
      sessionTimeoutSeconds: mock.sessionTimeoutSeconds,
      dataQuotaBytes: mock.dataQuotaBytes,
      createdAt: mock.createdAt,
    };
  }
}

/** Clear all mock resources (for test cleanup) */
export function clearMockMikroTikResources(): void {
  mockResources.clear();
  clearMockFailureSimulation();
}

export const mockMikroTikProviderClient = new MockMikroTikProviderClient();
