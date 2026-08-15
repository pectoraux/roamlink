/**
 * Phase 2C.4 — Real RouterOS Provider Client
 *
 * Implements the MikroTikProviderClient interface using the RouterOS REST API.
 * This is the production client that talks to real MikroTik routers.
 *
 * Architecture:
 *   MikroTikConnectivityAdapter (generic contract translation)
 *     → RouterOSProviderClient (this file — RouterOS-specific operations)
 *       → RouterOSTransport (HTTP transport — injectable for tests)
 *
 * The client translates generic resource operations (create, get, suspend,
 * resume, delete, getUsage) into RouterOS REST API calls.
 *
 * Error classification:
 *   RouterOS HTTP errors → MikroTikProviderError with typed errorType
 *   No RouterOS error strings leak into the generic entitlement layer.
 *
 * Idempotency:
 *   createResource: if user exists, return it (GET first, create if 404)
 *   suspendResource: PATCH disabled=true (idempotent)
 *   resumeResource: PATCH disabled=false (idempotent)
 *   deleteResource: DELETE (RouterOS returns 204 even if already deleted)
 *   getResource: GET (returns null on 404)
 */

import type { MikroTikProviderClient, MikroTikResource, MikroTikResourceConfig } from "./client";
import type { RouterOSTransport } from "./transport";
import { logger } from "@/lib/logger";

export class RouterOSProviderClient implements MikroTikProviderClient {
  constructor(
    private readonly transport: RouterOSTransport,
    /** Optional label for logging (e.g., "accra-01") */
    public readonly instanceLabel?: string,
  ) {}

  async createResource(config: MikroTikResourceConfig): Promise<MikroTikResource> {
    // Idempotent: check if resource already exists
    const existing = await this.getResource(config.username);
    if (existing) {
      logger.info("routeros.create_idempotent", { username: config.username, instance: this.instanceLabel });
      return existing;
    }

    // Create the hotspot user
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

    const created = await this.transport.request<Record<string, unknown>>({
      method: "POST",
      path: "/ip/hotspot/user",
      body,
    });

    logger.info("routeros.created", { username: config.username, instance: this.instanceLabel });

    return this.parseResource(config.username, created ?? {});
  }

  async getResource(username: string): Promise<MikroTikResource | null> {
    const data = await this.transport.request<Record<string, unknown>>({
      method: "GET",
      path: `/ip/hotspot/user/${encodeURIComponent(username)}`,
    });

    if (data === null) return null;

    return this.parseResource(username, data);
  }

  async suspendResource(username: string): Promise<void> {
    await this.transport.request({
      method: "PATCH",
      path: `/ip/hotspot/user/${encodeURIComponent(username)}`,
      body: { disabled: "true" },
    });
    logger.info("routeros.suspended", { username, instance: this.instanceLabel });
  }

  async resumeResource(username: string): Promise<void> {
    await this.transport.request({
      method: "PATCH",
      path: `/ip/hotspot/user/${encodeURIComponent(username)}`,
      body: { disabled: "false" },
    });
    logger.info("routeros.resumed", { username, instance: this.instanceLabel });
  }

  async deleteResource(username: string): Promise<void> {
    await this.transport.request({
      method: "DELETE",
      path: `/ip/hotspot/user/${encodeURIComponent(username)}`,
    });
    logger.info("routeros.deleted", { username, instance: this.instanceLabel });
  }

  async getResourceUsage(username: string): Promise<{
    downloadBytes: number;
    uploadBytes: number;
    sessionDurationSeconds: number;
    isActive: boolean;
  } | null> {
    // Check if resource exists first
    const resource = await this.getResource(username);
    if (!resource) return null;

    // Get active sessions (for usage data)
    const activeSessions = await this.transport.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: "/ip/hotspot/active",
    });

    // Find the session for this user
    const session = (activeSessions ?? []).find((s) => s.user === username);

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

  private parseResource(username: string, data: Record<string, unknown>): MikroTikResource {
    return {
      id: username,
      resourceType: "hotspot_user",
      isActive: data.disabled !== "true",
      downloadRateLimitBps: this.parseRateLimit(data["rate-limit"] as string | undefined, "down"),
      uploadRateLimitBps: this.parseRateLimit(data["rate-limit"] as string | undefined, "up"),
      sessionTimeoutSeconds: this.parseDurationSeconds(data["session-timeout"] as string | undefined),
      dataQuotaBytes: this.parseIntSafe(data["limit-bytes-total"] as string | undefined),
      createdAt: new Date(), // RouterOS doesn't expose creation time via REST
    };
  }

  /**
   * Format rate limit for RouterOS.
   * RouterOS format: "down/up" (e.g., "50M/10M" for 50Mbps down, 10Mbps up)
   */
  private formatRateLimit(downBps: number, upBps: number): string | null {
    if (downBps === 0 && upBps === 0) return null;
    const down = downBps > 0 ? `${Math.floor(downBps / 1_000_000)}M` : "0";
    const up = upBps > 0 ? `${Math.floor(upBps / 1_000_000)}M` : "0";
    return `${down}/${up}`;
  }

  /**
   * Parse RouterOS rate limit string (e.g., "50M/10M") into bps.
   */
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

  /**
   * Format duration in seconds as RouterOS duration string.
   * RouterOS format: "1d2h3m4s" etc.
   */
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

  /**
   * Parse RouterOS duration string (e.g., "1d2h3m4s") into seconds.
   */
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

  /**
   * Parse a RouterOS numeric string (may be empty or "0").
   */
  private parseIntSafe(value: string | undefined): number {
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
}
