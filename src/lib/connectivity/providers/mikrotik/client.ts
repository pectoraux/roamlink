/**
 * Phase 2C.3 — MikroTik Provider Client Interface
 *
 * The provider client handles low-level RouterOS/RADIUS/Hotspot API calls.
 * The adapter (MikroTikConnectivityAdapter) translates the generic
 * ConnectivityProviderAdapter contract into provider-client calls.
 *
 * This separation allows the transport (RouterOS REST API, RADIUS, CAPsMAN)
 * to change without modifying the adapter.
 *
 * Error classification:
 *   RETRYABLE       — transient (timeout, 5xx, rate limit)
 *   PERMANENT       — permanent (invalid config, unsupported capability)
 *   AUTHENTICATION  — auth failure (bad credentials)
 *   NOT_FOUND       — resource doesn't exist at the provider
 *   CONFLICT        — duplicate resource with different config
 *   TIMEOUT         — provider didn't respond
 */

export type MikroTikErrorType =
  | "RETRYABLE"
  | "PERMANENT"
  | "AUTHENTICATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT";

export class MikroTikProviderError extends Error {
  constructor(
    public readonly errorType: MikroTikErrorType,
    message: string,
  ) {
    super(message);
    this.name = "MikroTikProviderError";
  }
}

/**
 * A MikroTik resource (hotspot user, RADIUS subscriber, PPPoE session).
 */
export type MikroTikResource = {
  /** The resource identifier (e.g., username, RADIUS username) */
  id: string;
  /** Resource type: "hotspot_user" | "radius_subscriber" | "pppoe_session" */
  resourceType: string;
  /** Whether the resource is currently active/enabled */
  isActive: boolean;
  /** Download rate limit in bps (0 = unlimited) */
  downloadRateLimitBps?: number;
  /** Upload rate limit in bps (0 = unlimited) */
  uploadRateLimitBps?: number;
  /** Session timeout in seconds (0 = no timeout) */
  sessionTimeoutSeconds?: number;
  /** Data quota in bytes (0 = unlimited) */
  dataQuotaBytes?: number;
  /** When the resource was created at the provider */
  createdAt: Date;
};

/**
 * Configuration for creating a MikroTik resource.
 */
export type MikroTikResourceConfig = {
  resourceType: string; // "hotspot_user" | "radius_subscriber"
  username: string;
  password: string;
  downloadRateLimitBps?: number;
  uploadRateLimitBps?: number;
  sessionTimeoutSeconds?: number;
  dataQuotaBytes?: number;
};

/**
 * The provider client interface.
 * Implementations:
 *   - MockMikroTikProviderClient (for testing)
 *   - RouterOSProviderClient (for real RouterOS REST API — Phase 2C.3+ future)
 */
export interface MikroTikProviderClient {
  /**
   * Create a resource (hotspot user, RADIUS subscriber, etc.).
   * Idempotent: if a resource with the same username already exists, return it.
   * @throws MikroTikProviderError on failure
   */
  createResource(config: MikroTikResourceConfig): Promise<MikroTikResource>;

  /**
   * Get a resource by username.
   * @returns The resource, or null if not found
   * @throws MikroTikProviderError on transient failures
   */
  getResource(username: string): Promise<MikroTikResource | null>;

  /**
   * Suspend a resource (disable it temporarily).
   * Idempotent: suspending an already-suspended resource is a no-op.
   * @throws MikroTikProviderError on failure
   */
  suspendResource(username: string): Promise<void>;

  /**
   * Resume a suspended resource.
   * Idempotent: resuming an already-active resource is a no-op.
   * @throws MikroTikProviderError on failure
   */
  resumeResource(username: string): Promise<void>;

  /**
   * Delete a resource permanently.
   * Idempotent: deleting a non-existent resource is a no-op.
   * @throws MikroTikProviderError on failure
   */
  deleteResource(username: string): Promise<void>;

  /**
   * Get current usage for a resource.
   * @returns Usage data, or null if the resource doesn't exist
   */
  getResourceUsage(username: string): Promise<{
    downloadBytes: number;
    uploadBytes: number;
    sessionDurationSeconds: number;
    isActive: boolean;
  } | null>;
}
