/**
 * Phase 2C.4 — RouterOS REST API Transport
 *
 * Low-level HTTP transport for RouterOS REST API.
 * Handles:
 *   - HTTP/HTTPS requests
 *   - Bearer token authentication
 *   - Request timeout (AbortController)
 *   - Bounded retries for retryable failures (5xx, 429, network errors)
 *   - No retry for permanent/auth errors (4xx except 429)
 *   - Status-code classification into MikroTikErrorType
 *   - Response validation
 *   - Structured errors via MikroTikProviderError
 *
 * The transport is injectable for testing — tests can provide a
 * MockRouterOSTransport that simulates RouterOS responses.
 *
 * RouterOS REST API (RouterOS v7+):
 *   Base URL: https://<router-ip>/rest
 *   Auth: Bearer token (base64(user:pass)) or Basic auth
 *   Content-Type: application/json
 *
 * Key endpoints used:
 *   GET    /rest/ip/hotspot/user                    — list users
 *   POST   /rest/ip/hotspot/user                    — create user
 *   GET    /rest/ip/hotspot/user/{name}             — get user
 *   PATCH  /rest/ip/hotspot/user/{name}             — update user
 *   DELETE /rest/ip/hotspot/user/{name}             — delete user
 *   GET    /rest/ip/hotspot/active                  — active sessions
 */

import { MikroTikProviderError } from "./client";
import type { MikroTikErrorType } from "./client";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Transport Configuration
// ---------------------------------------------------------------------------

export type RouterOSTransportConfig = {
  /** Base URL, e.g., "https://192.168.1.1/rest" */
  endpoint: string;
  /** Username for RouterOS API */
  username: string;
  /** Password for RouterOS API */
  password: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Max retries for retryable errors (default: 2) */
  maxRetries?: number;
  /** Allow self-signed certificates (default: false — PRODUCTION MUST BE false) */
  allowInsecureTls?: boolean;
};

// ---------------------------------------------------------------------------
// Transport Interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * The transport interface. Production uses FetchRouterOSTransport;
 * tests use MockRouterOSTransport.
 */
export interface RouterOSTransport {
  /**
   * Execute a RouterOS REST API request.
   * @returns parsed JSON response, or null for 404
   * @throws MikroTikProviderError on any failure
   */
  request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string; // e.g., "/ip/hotspot/user/testuser"
    body?: Record<string, unknown>;
  }): Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

/**
 * Map HTTP status codes to MikroTikErrorType.
 */
function classifyHttpStatus(status: number): MikroTikErrorType {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RETRYABLE";
  if (status >= 500) return "RETRYABLE";
  if (status >= 400) return "PERMANENT";
  return "PERMANENT"; // unexpected
}

/**
 * Determine if an error type is retryable.
 */
function isRetryable(errorType: MikroTikErrorType): boolean {
  return errorType === "RETRYABLE" || errorType === "TIMEOUT";
}

// ---------------------------------------------------------------------------
// Fetch-based RouterOS Transport (Production)
// ---------------------------------------------------------------------------

export class FetchRouterOSTransport implements RouterOSTransport {
  private readonly config: Required<RouterOSTransportConfig>;

  constructor(config: RouterOSTransportConfig) {
    this.config = {
      timeoutMs: 10000,
      maxRetries: 2,
      allowInsecureTls: false,
      ...config,
    };

    if (this.config.allowInsecureTls && process.env.NODE_ENV === "production") {
      throw new Error("Insecure TLS is not allowed in production");
    }
  }

  async request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T | null> {
    const url = `${this.config.endpoint}${input.path}`;
    const authHeader = "Basic " + Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");

    let lastError: MikroTikProviderError | null = null;
    const maxAttempts = 1 + this.config.maxRetries;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const fetchOptions: RequestInit = {
          method: input.method,
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        };

        if (input.body && input.method !== "GET") {
          fetchOptions.body = JSON.stringify(input.body);
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        // 404 → null (resource not found)
        if (response.status === 404) {
          return null;
        }

        // 204 → success with no body (e.g., DELETE)
        if (response.status === 204) {
          return null;
        }

        // Success
        if (response.status >= 200 && response.status < 300) {
          const text = await response.text();
          if (!text) return null;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new MikroTikProviderError("PERMANENT", `RouterOS returned malformed JSON: ${text.substring(0, 200)}`);
          }
        }

        // Error status
        const errorType = classifyHttpStatus(response.status);
        const errorBody = await response.text().catch(() => "");
        const errorMsg = `RouterOS ${input.method} ${input.path} → ${response.status}: ${errorBody.substring(0, 200)}`;

        lastError = new MikroTikProviderError(errorType, errorMsg);

        // Don't retry non-retryable errors
        if (!isRetryable(errorType)) {
          throw lastError;
        }

        // Retryable — wait before retry (exponential backoff)
        if (attempt < this.config.maxRetries) {
          const delayMs = Math.pow(2, attempt) * 500; // 500ms, 1000ms
          logger.warn("routeros.transport_retrying", { attempt: attempt + 1, delayMs, status: response.status, path: input.path });
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof MikroTikProviderError) {
          throw err; // already classified
        }

        // AbortError → timeout
        if (err instanceof Error && err.name === "AbortError") {
          lastError = new MikroTikProviderError("TIMEOUT", `RouterOS request timed out after ${this.config.timeoutMs}ms: ${input.method} ${input.path}`);
        } else {
          // Network error (fetch failed) → retryable
          const errorMsg = err instanceof Error ? err.message : String(err);
          lastError = new MikroTikProviderError("RETRYABLE", `RouterOS network error: ${errorMsg}`);
        }

        // Don't retry non-retryable
        if (!isRetryable(lastError.errorType)) {
          throw lastError;
        }

        if (attempt < this.config.maxRetries) {
          const delayMs = Math.pow(2, attempt) * 500;
          logger.warn("routeros.transport_retrying", { attempt: attempt + 1, delayMs, error: lastError.message });
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    // Exhausted retries
    throw lastError ?? new MikroTikProviderError("PERMANENT", "RouterOS request failed after all retries");
  }
}

// ---------------------------------------------------------------------------
// Mock RouterOS Transport (for tests)
// ---------------------------------------------------------------------------

/**
 * Test double for RouterOSTransport. Simulates RouterOS responses
 * without requiring a real router.
 */
export class MockRouterOSTransport implements RouterOSTransport {
  /** Simulated RouterOS resources: username → resource data */
  readonly resources = new Map<string, Record<string, unknown>>();
  /** Operation log for test verification */
  readonly operationLog: Array<{ method: string; path: string; timestamp: Date }> = [];

  private failureMode: { type: MikroTikErrorType; status?: number; paths?: string[] } | null = null;

  /**
   * Set a failure mode for the next requests.
   * @param type error type to simulate
   * @param status HTTP status code to return (optional)
   * @param paths only fail for these paths (optional, fails all if not set)
   */
  setFailureMode(type: MikroTikErrorType, status?: number, paths?: string[]): void {
    this.failureMode = { type, status, paths };
  }

  /** Clear failure mode */
  clearFailureMode(): void {
    this.failureMode = null;
  }

  async request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T | null> {
    this.operationLog.push({ method: input.method, path: input.path, timestamp: new Date() });

    // Check failure mode
    if (this.failureMode) {
      const shouldFail = !this.failureMode.paths || this.failureMode.paths.some((p) => input.path.includes(p));
      if (shouldFail) {
        const fm = this.failureMode;
        if (fm.type === "TIMEOUT") {
          throw new MikroTikProviderError("TIMEOUT", `Simulated timeout: ${input.method} ${input.path}`);
        }
        const status = fm.status ?? (fm.type === "AUTHENTICATION" ? 401 : fm.type === "NOT_FOUND" ? 404 : fm.type === "CONFLICT" ? 409 : fm.type === "RETRYABLE" ? 500 : 400);
        throw new MikroTikProviderError(fm.type, `Simulated ${fm.type}: ${input.method} ${input.path} → ${status}`);
      }
    }

    // Parse path: /ip/hotspot/user/{id} or /ip/hotspot/user?name={username}
    const hotspotUserMatch = input.path.match(/^\/ip\/hotspot\/user\/(.+)$/);
    const hotspotUserQuery = input.path.match(/^\/ip\/hotspot\/user\?(.+)$/);
    const hotspotUserBase = input.path === "/ip/hotspot/user";

    // GET /ip/hotspot/user?name={username} — lookup by name
    if (input.method === "GET" && hotspotUserQuery) {
      const params = new URLSearchParams(hotspotUserQuery[1]);
      const name = params.get("name");
      if (name) {
        const resource = this.resources.get(name);
        if (!resource) return [] as T; // empty array
        return [resource] as T;
      }
    }

    // GET /ip/hotspot/user/{id} — get by .id
    if (input.method === "GET" && hotspotUserMatch) {
      const idOrUsername = decodeURIComponent(hotspotUserMatch[1]);
      // Try by .id first, then by username
      for (const [username, resource] of this.resources) {
        if (resource[".id"] === idOrUsername || username === idOrUsername) {
          return resource as T;
        }
      }
      return null; // 404
    }

    // GET /ip/hotspot/user — list all
    if (input.method === "GET" && hotspotUserBase) {
      return Array.from(this.resources.values()) as T;
    }

    // PUT /ip/hotspot/user — create (RouterOS REST CRUD: PUT = create)
    if (input.method === "PUT" && hotspotUserBase) {
      const username = input.body?.name as string;
      if (!username) throw new MikroTikProviderError("PERMANENT", "Missing 'name' in create body");
      // Idempotent: if exists, return it
      if (this.resources.has(username)) {
        return this.resources.get(username) as T;
      }
      const resource = {
        ".id": `*${Date.now().toString(36)}`,
        name: username,
        password: input.body?.password ?? "",
        "rate-limit": input.body?.["rate-limit"] ?? "",
        disabled: "false",
        ...input.body,
      };
      this.resources.set(username, resource);
      return resource as T;
    }

    // PATCH /ip/hotspot/user/{id} — update by .id
    if (input.method === "PATCH" && hotspotUserMatch) {
      const idOrUsername = decodeURIComponent(hotspotUserMatch[1]);
      // Find by .id or username
      let foundUsername: string | null = null;
      for (const [username, resource] of this.resources) {
        if (resource[".id"] === idOrUsername || username === idOrUsername) {
          foundUsername = username;
          break;
        }
      }
      if (!foundUsername) {
        throw new MikroTikProviderError("NOT_FOUND", `Resource not found: ${idOrUsername}`);
      }
      const existing = this.resources.get(foundUsername)!;
      const updated = { ...existing, ...input.body };
      this.resources.set(foundUsername, updated);
      return updated as T;
    }

    // DELETE /ip/hotspot/user/{id} — delete by .id
    if (input.method === "DELETE" && hotspotUserMatch) {
      const idOrUsername = decodeURIComponent(hotspotUserMatch[1]);
      // Find by .id or username
      let foundUsername: string | null = null;
      for (const [username, resource] of this.resources) {
        if (resource[".id"] === idOrUsername || username === idOrUsername) {
          foundUsername = username;
          break;
        }
      }
      if (foundUsername) {
        this.resources.delete(foundUsername);
      }
      return null; // 204 — idempotent
    }

    // GET /ip/hotspot/active — active sessions (for usage)
    if (input.method === "GET" && input.path === "/ip/hotspot/active") {
      const active: Record<string, unknown>[] = [];
      for (const [username, resource] of this.resources) {
        if (resource.disabled !== "true") {
          active.push({
            user: username,
            "bytes-in": Math.floor(Math.random() * 1_000_000_000),
            "bytes-out": Math.floor(Math.random() * 100_000_000),
            uptime: `1h30m`,
          });
        }
      }
      return active as T;
    }

    throw new MikroTikProviderError("PERMANENT", `Unhandled RouterOS request: ${input.method} ${input.path}`);
  }
}
