/**
 * Phase 2C.4 / 2C.4.1 / 2C.4.6 — Real RouterOS Provider Client
 *
 * Implements the MikroTikProviderClient interface using the RouterOS REST API.
 *
 * Phase 2C.4.1 — PROTOCOL CORRECTNESS:
 *   - Uses PUT for create (RouterOS REST CRUD: PUT=create, PATCH=update,
 *     DELETE=delete, GET=read, POST=command)
 *   - Uses RouterOS .id (returned from PUT) for GET/PATCH/DELETE addressing
 *   - Username (name) used for lookup, .id used for resource addressing
 *   - Create retries: after timeout/ambiguity, GET to reconcile before retry
 *   - No blind retry of non-idempotent create
 *
 * Phase 2C.4.6 — PROVIDER-SIDE CONVERGENCE:
 *   A database lease can fence LOCAL state (stale workers cannot finalize),
 *   but it CANNOT fence an already-started EXTERNAL operation. If worker A
 *   sends a PUT to RouterOS and then loses its DB lease, worker B may take
 *   over and also send a PUT. The DB lease cannot make either in-flight HTTP
 *   request disappear.
 *
 *   Provider-side safety is therefore an INDEPENDENT layer: the create
 *   operation must be CONVERGENT — replay, concurrent, or uncertain attempts
 *   must all resolve to exactly ONE external resource, bound by the stable
 *   binding identity (username).
 *
 *   Convergence strategy (three reconciliation paths):
 *     1. GET by username → if exists, return it (idempotent — no PUT needed)
 *     2. PUT → CONFLICT (409): another worker created it between our GET and
 *        PUT. Reconcile: GET by username → if found, return it (convergence).
 *     3. PUT → TIMEOUT/RETRYABLE: uncertain outcome. Reconcile: GET by
 *        username → if found, return it; if absent, one controlled retry.
 *
 *   In all three paths, two concurrent workers converge on the SAME external
 *   resource, identified by the stable username. No duplicate RouterOS user
 *   is ever created.
 *
 * Idempotency strategy for create:
 *   1. GET by username → if exists, return it (idempotent)
 *   2. PUT create → if timeout/error, DON'T blindly retry
 *   3. After ambiguity: GET by username → if exists, return it (reconcile)
 *   4. Only retry PUT if GET confirms resource is absent
 *   5. [2C.4.6] PUT → CONFLICT → GET by username → return existing (converge)
 *
 * Resource identity:
 *   - RoamLink providerResourceId = RouterOS .id (the internal record ID)
 *   - HotSpot username (name) = immutable correlation attribute
 *   - GET by username uses ?name= query; GET/PATCH/DELETE by .id uses /{.id}
 */

import type { MikroTikProviderClient, MikroTikResource, MikroTikResourceConfig } from "./client";
import { MikroTikProviderError } from "./client";
import type { RouterOSTransport } from "./transport";
import { logger } from "@/lib/logger";

export class RouterOSProviderClient implements MikroTikProviderClient {
  constructor(
    private readonly transport: RouterOSTransport,
    /** Optional label for logging (e.g., "accra-01") */
    public readonly instanceLabel?: string,
  ) {}

  async createResource(config: MikroTikResourceConfig): Promise<MikroTikResource> {
    // Step 1: Check if resource already exists (idempotent).
    // Phase 2C.4.3: FAIL CLOSED on lookup uncertainty.
    // Unknown external state ≠ resource absent.
    // If the GET lookup fails with a retryable/timeout error, we do NOT
    // proceed to PUT — we don't know whether the resource already exists.
    // Only confirmed absence permits creation.
    let existing: MikroTikResource | null;
    try {
      existing = await this.getResourceByUsername(config.username);
    } catch (err) {
      // Any lookup failure (retryable, timeout, auth, permanent) → FAIL CLOSED.
      // Do NOT proceed to PUT with unknown external state.
      if (err instanceof MikroTikProviderError) {
        logger.error("routeros.create_lookup_failed_closed", {
          username: config.username, instance: this.instanceLabel,
          errorType: err.errorType,
          error: err.message,
          message: "CRITICAL: Idempotency lookup failed — refusing to create with unknown external state.",
        });
        throw err; // Re-throw — the caller (adapter) will classify it
      }
      throw err;
    }
    if (existing) {
      logger.info("routeros.create_idempotent", { username: config.username, instance: this.instanceLabel });
      return existing;
    }

    // Step 2: Create using PUT (RouterOS REST CRUD: PUT = create)
    const rateLimit = this.formatRateLimit(
      config.downloadRateLimitBps ?? 0,
      config.uploadRateLimitBps ?? 0,
    );

    const body: Record<string, unknown> = {
      name: config.username,
      password: config.password,
    };
    if (rateLimit) {
      body["rate-limit"] = rateLimit;
    }
    if (config.sessionTimeoutSeconds && config.sessionTimeoutSeconds > 0) {
      body["session-timeout"] = this.formatDuration(config.sessionTimeoutSeconds);
    }
    if (config.dataQuotaBytes && config.dataQuotaBytes > 0) {
      body["limit-bytes-total"] = String(config.dataQuotaBytes);
    }

    try {
      const created = await this.transport.request<Record<string, unknown>>({
        method: "PUT",
        path: "/ip/hotspot/user",
        body,
      });

      logger.info("routeros.created", { username: config.username, instance: this.instanceLabel });
      return this.parseResource(created ?? {});
    } catch (err) {
      // Phase 2C.4.6: CONFLICT (409) reconciliation — provider-side convergence.
      //
      // A CONFLICT means another worker created the resource between our GET
      // (which saw absence) and our PUT. This is the core concurrent-creation
      // race that a DB lease CANNOT prevent: both workers did GET (absent),
      // both issued PUT, and the second PUT conflicts.
      //
      // The resource now exists at the provider. We MUST converge: GET by
      // username → return the existing resource. We must NOT treat this as a
      // hard failure — the external state is consistent (exactly one
      // resource), and the binding should bind to it.
      if (err instanceof MikroTikProviderError && err.errorType === "CONFLICT") {
        logger.warn("routeros.create_conflict_reconciling", {
          username: config.username, instance: this.instanceLabel,
          error: err.message,
          message: "PUT conflicted (another worker created the resource) — reconciling via GET to converge on the existing resource.",
        });

        const reconciled = await this.getResourceByUsername(config.username);
        if (reconciled) {
          logger.info("routeros.create_conflict_reconciled", {
            username: config.username, instance: this.instanceLabel,
            resourceId: reconciled.id,
            message: "CONFLICT reconciled — binding to the existing resource created by another worker.",
          });
          return reconciled;
        }

        // CONFLICT but the resource is not found by GET — this is a genuine
        // provider inconsistency. Fail closed; do NOT retry PUT.
        logger.error("routeros.create_conflict_inconsistent", {
          username: config.username, instance: this.instanceLabel,
          message: "CRITICAL: PUT returned CONFLICT but GET cannot find the resource — provider state is inconsistent. Failing closed.",
        });
        throw new MikroTikProviderError(
          "PERMANENT",
          `Provider inconsistency: PUT conflicted but GET cannot find resource "${config.username}"`,
        );
      }

      // Phase 2C.4.1: Don't blindly retry create on timeout/network error.
      // Instead, reconcile: check if the resource was actually created.
      if (err instanceof MikroTikProviderError && (err.errorType === "TIMEOUT" || err.errorType === "RETRYABLE")) {
        logger.warn("routeros.create_uncertain", {
          username: config.username, instance: this.instanceLabel,
          error: err.message,
          message: "Create request had uncertain outcome — reconciling via GET before retry.",
        });

        // Reconcile: check if the resource was created despite the error
        const reconciled = await this.getResourceByUsername(config.username);
        if (reconciled) {
          logger.info("routeros.create_reconciled", {
            username: config.username, instance: this.instanceLabel,
            message: "Resource exists despite uncertain create — returning existing resource.",
          });
          return reconciled;
        }

        // Resource doesn't exist — safe to retry create
        logger.info("routeros.create_retry_after_reconcile", {
          username: config.username, instance: this.instanceLabel,
        });
        const created = await this.transport.request<Record<string, unknown>>({
          method: "PUT",
          path: "/ip/hotspot/user",
          body,
        });
        logger.info("routeros.created_retry", { username: config.username, instance: this.instanceLabel });
        return this.parseResource(created ?? {});
      }

      // Non-retryable error — rethrow
      throw err;
    }
  }

  /**
   * Get a resource by its RouterOS .id (the internal record ID).
   * This is the primary resource addressing method for GET/PATCH/DELETE.
   */
  async getResource(routerOSId: string): Promise<MikroTikResource | null> {
    const data = await this.transport.request<Record<string, unknown>>({
      method: "GET",
      path: `/ip/hotspot/user/${encodeURIComponent(routerOSId)}`,
    });

    if (data === null) return null;
    return this.parseResource(data);
  }

  /**
   * Lookup a resource by username (the HotSpot user name).
   * Uses the ?name= query parameter.
   * This is used for idempotency checks during create.
   */
  private async getResourceByUsername(username: string): Promise<MikroTikResource | null> {
    const results = await this.transport.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: `/ip/hotspot/user?name=${encodeURIComponent(username)}`,
    });

    if (!results || results.length === 0) return null;
    return this.parseResource(results[0]);
  }

  async suspendResource(routerOSId: string): Promise<void> {
    await this.transport.request({
      method: "PATCH",
      path: `/ip/hotspot/user/${encodeURIComponent(routerOSId)}`,
      body: { disabled: "true" },
    });
    logger.info("routeros.suspended", { routerOSId, instance: this.instanceLabel });
  }

  async resumeResource(routerOSId: string): Promise<void> {
    await this.transport.request({
      method: "PATCH",
      path: `/ip/hotspot/user/${encodeURIComponent(routerOSId)}`,
      body: { disabled: "false" },
    });
    logger.info("routeros.resumed", { routerOSId, instance: this.instanceLabel });
  }

  async deleteResource(routerOSId: string): Promise<void> {
    await this.transport.request({
      method: "DELETE",
      path: `/ip/hotspot/user/${encodeURIComponent(routerOSId)}`,
    });
    logger.info("routeros.deleted", { routerOSId, instance: this.instanceLabel });
  }

  async getResourceUsage(routerOSId: string): Promise<{
    downloadBytes: number;
    uploadBytes: number;
    sessionDurationSeconds: number;
    isActive: boolean;
  } | null> {
    // Get the resource to check if it exists and get its username
    const resource = await this.getResource(routerOSId);
    if (!resource) return null;

    // Get active sessions (for usage data)
    const activeSessions = await this.transport.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: "/ip/hotspot/active",
    });

    // Phase 2C.4.2: Use resource.username (NOT resource.id) for active-session correlation.
    // Active sessions are keyed by HotSpot username (the `user` field), not by RouterOS .id.
    const session = (activeSessions ?? []).find((s) => s.user === resource.username);

    return {
      downloadBytes: this.parseIntSafe(session?.["bytes-in"] as string | undefined),
      uploadBytes: this.parseIntSafe(session?.["bytes-out"] as string | undefined),
      sessionDurationSeconds: this.parseDurationSeconds(session?.uptime as string | undefined),
      isActive: resource.isActive,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse a RouterOS resource response into MikroTikResource.
   *
   * Phase 2C.4.2: Resource identity is properly separated:
   *   id       = RouterOS .id (internal record ID, used for addressing)
   *   username = HotSpot username (name field, used for active-session correlation)
   */
  private parseResource(data: Record<string, unknown>): MikroTikResource {
    return {
      id: (data[".id"] as string) ?? "",
      username: (data.name as string) ?? "",
      resourceType: "hotspot_user",
      isActive: data.disabled !== "true",
      downloadRateLimitBps: this.parseRateLimit(data["rate-limit"] as string | undefined, "down"),
      uploadRateLimitBps: this.parseRateLimit(data["rate-limit"] as string | undefined, "up"),
      sessionTimeoutSeconds: this.parseDurationSeconds(data["session-timeout"] as string | undefined),
      dataQuotaBytes: this.parseIntSafe(data["limit-bytes-total"] as string | undefined),
      createdAt: new Date(),
    };
  }

  private formatRateLimit(downBps: number, upBps: number): string | null {
    if (downBps === 0 && upBps === 0) return null;
    const down = downBps > 0 ? `${Math.floor(downBps / 1_000_000)}M` : "0";
    const up = upBps > 0 ? `${Math.floor(upBps / 1_000_000)}M` : "0";
    return `${down}/${up}`;
  }

  private parseRateLimit(rateLimit: string | undefined, direction: "down" | "up"): number | undefined {
    if (!rateLimit) return undefined;
    const parts = rateLimit.split("/");
    const value = direction === "down" ? parts[0] : parts[1];
    if (!value || value === "0") return 0;
    const match = value.match(/^(\d+)([KMGT]?)$/i);
    if (!match) return undefined;
    const num = parseInt(match[1], 10);
    const unit = match[2].toUpperCase();
    const multiplier = unit === "K" ? 1_000 : unit === "M" ? 1_000_000 : unit === "G" ? 1_000_000_000 : unit === "T" ? 1_000_000_000_000 : 1;
    return num * multiplier;
  }

  private formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    let result = "";
    if (days > 0) result += `${days}d`;
    if (hours > 0) result += `${hours}h`;
    if (mins > 0) result += `${mins}m`;
    if (secs > 0) result += `${secs}s`;
    return result || "0s";
  }

  private parseDurationSeconds(duration: string | undefined): number {
    if (!duration) return 0;
    let total = 0;
    const matches = duration.matchAll(/(\d+)([wdhms])/gi);
    for (const match of matches) {
      const num = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      const multiplier = unit === "w" ? 604800 : unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
      total += num * multiplier;
    }
    return total;
  }

  private parseIntSafe(value: string | undefined): number {
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
}
