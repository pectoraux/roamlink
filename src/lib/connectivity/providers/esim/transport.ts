/**
 * Phase 2C.5 — eSIM Supplier Transport (Fetch + Mock)
 *
 * Low-level HTTP transport for a realistic eSIM supplier REST API.
 * Mirrors the RouterOS transport structure exactly.
 *
 * eSIM Supplier API (realistic pattern, e.g. Airalo-style):
 *   Base URL: https://api.esim-supplier.com/v1
 *   Auth: Bearer token (API key)
 *   POST   /profiles                  — create eSIM profile
 *   GET    /profiles?reference={ref}  — lookup by reference (convergence key)
 *   GET    /profiles/{iccid}          — get profile by ICCID
 *   PATCH  /profiles/{iccid}          — update (suspend/resume)
 *   DELETE /profiles/{iccid}          — release profile
 *   GET    /profiles/{iccid}/usage    — get data usage
 */

import { EsimProviderError } from "./client";
import type { EsimErrorType } from "./client";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Transport Configuration
// ---------------------------------------------------------------------------

export type EsimTransportConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
};

// ---------------------------------------------------------------------------
// Transport Interface
// ---------------------------------------------------------------------------

export interface EsimTransport {
  request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Error Classification (same logic as RouterOS)
// ---------------------------------------------------------------------------

function classifyHttpStatus(status: number): EsimErrorType {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RETRYABLE";
  if (status >= 500) return "RETRYABLE";
  if (status >= 400) return "PERMANENT";
  return "PERMANENT";
}

function isRetryable(type: EsimErrorType): boolean {
  return type === "RETRYABLE" || type === "TIMEOUT";
}

// ---------------------------------------------------------------------------
// Fetch-based eSIM Transport (Production)
// ---------------------------------------------------------------------------

export class FetchEsimTransport implements EsimTransport {
  private readonly config: Required<EsimTransportConfig>;

  constructor(config: EsimTransportConfig) {
    this.config = {
      timeoutMs: 15000,
      maxRetries: 2,
      ...config,
    };
  }

  async request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T | null> {
    const url = `${this.config.endpoint}${input.path}`;
    const authHeader = `Bearer ${this.config.apiKey}`;

    let lastError: EsimProviderError | null = null;

    // Method-specific retry policy (same as RouterOS):
    // POST (create) is NOT retried — the client owns create retry semantics.
    const isMethodRetryable = input.method === "GET" || input.method === "PATCH" || input.method === "DELETE";
    const maxAttempts = isMethodRetryable ? (1 + this.config.maxRetries) : 1;

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

        if (response.status === 404) return null;
        if (response.status === 204) return null;

        if (response.status >= 200 && response.status < 300) {
          const text = await response.text();
          if (!text) return null;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new EsimProviderError("PERMANENT", `eSIM supplier returned malformed JSON: ${text.substring(0, 200)}`);
          }
        }

        const errorType = classifyHttpStatus(response.status);
        const errorBody = await response.text().catch(() => "");
        const errorMsg = `eSIM ${input.method} ${input.path} → ${response.status}: ${errorBody.substring(0, 200)}`;
        lastError = new EsimProviderError(errorType, errorMsg);

        if (!isRetryable(errorType)) throw lastError;

        if (attempt < this.config.maxRetries) {
          const delayMs = Math.pow(2, attempt) * 500;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof EsimProviderError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          lastError = new EsimProviderError("TIMEOUT", `eSIM request timed out after ${this.config.timeoutMs}ms: ${input.method} ${input.path}`);
        } else {
          lastError = new EsimProviderError("RETRYABLE", `eSIM network error: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!isRetryable(lastError.errorType)) throw lastError;
        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
        }
      }
    }
    throw lastError ?? new EsimProviderError("PERMANENT", "eSIM request failed after all retries");
  }
}

// ---------------------------------------------------------------------------
// Mock eSIM Transport (for tests)
// ---------------------------------------------------------------------------

export class MockEsimTransport implements EsimTransport {
  readonly profiles = new Map<string, Record<string, unknown>>();
  readonly operationLog: Array<{ method: string; path: string; timestamp: Date }> = [];

  private failureMode: { type: EsimErrorType; status?: number; paths?: string[] } | null = null;
  private strictConflictMode = false;

  setStrictConflictMode(enabled: boolean): void {
    this.strictConflictMode = enabled;
  }

  setFailureMode(type: EsimErrorType, status?: number, paths?: string[]): void {
    this.failureMode = { type, status, paths };
  }

  clearFailureMode(): void {
    this.failureMode = null;
  }

  async request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T | null> {
    this.operationLog.push({ method: input.method, path: input.path, timestamp: new Date() });

    if (this.failureMode) {
      const shouldFail = !this.failureMode.paths || this.failureMode.paths.some((p) => input.path.includes(p));
      if (shouldFail) {
        const fm = this.failureMode;
        if (fm.type === "TIMEOUT") {
          throw new EsimProviderError("TIMEOUT", `Simulated timeout: ${input.method} ${input.path}`);
        }
        const status = fm.status ?? (fm.type === "AUTHENTICATION" ? 401 : fm.type === "NOT_FOUND" ? 404 : fm.type === "CONFLICT" ? 409 : fm.type === "RETRYABLE" ? 500 : 400);
        throw new EsimProviderError(fm.type, `Simulated ${fm.type}: ${input.method} ${input.path} → ${status}`);
      }
    }

    const profileMatch = input.path.match(/^\/profiles\/(.+)$/);
    const profileQuery = input.path.match(/^\/profiles\?(.+)$/);
    const profileBase = input.path === "/profiles";
    const usageMatch = input.path.match(/^\/profiles\/(.+)\/usage$/);

    // GET /profiles?reference={ref} — lookup by reference
    if (input.method === "GET" && profileQuery && !usageMatch) {
      const params = new URLSearchParams(profileQuery[1]);
      const ref = params.get("reference");
      if (ref) {
        const profile = this.profiles.get(ref);
        if (!profile) return [] as T;
        return [profile] as T;
      }
    }

    // GET /profiles/{iccid}/usage
    if (input.method === "GET" && usageMatch) {
      const iccid = decodeURIComponent(usageMatch[1]);
      for (const [, profile] of this.profiles) {
        if (profile.iccid === iccid) {
          return {
            dataUsedBytes: profile.dataUsedBytes ?? 0,
            dataLimitBytes: profile.dataLimitBytes ?? 0,
            remainingBytes: (profile.dataLimitBytes as number ?? 0) - (profile.dataUsedBytes as number ?? 0),
            isActive: profile.status !== "suspended",
          } as T;
        }
      }
      return null;
    }

    // GET /profiles/{iccid}
    if (input.method === "GET" && profileMatch && !usageMatch) {
      const iccid = decodeURIComponent(profileMatch[1]);
      for (const [, profile] of this.profiles) {
        if (profile.iccid === iccid) return profile as T;
      }
      return null;
    }

    // POST /profiles — create
    if (input.method === "POST" && profileBase) {
      const reference = input.body?.reference as string;
      if (!reference) throw new EsimProviderError("PERMANENT", "Missing 'reference' in create body");
      if (this.profiles.has(reference)) {
        if (this.strictConflictMode) {
          throw new EsimProviderError("CONFLICT", `Simulated eSIM 409: profile "${reference}" already exists`);
        }
        return this.profiles.get(reference) as T;
      }
      const iccid = `89${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const profile = {
        iccid,
        reference,
        status: "active",
        dataLimitBytes: input.body?.dataLimitBytes ?? 0,
        dataUsedBytes: 0,
        allowedCountries: input.body?.allowedCountries ?? [],
        validityDays: input.body?.validityDays ?? 30,
        createdAt: new Date().toISOString(),
      };
      this.profiles.set(reference, profile);
      return profile as T;
    }

    // PATCH /profiles/{iccid} — update (suspend/resume)
    if (input.method === "PATCH" && profileMatch && !usageMatch) {
      const iccid = decodeURIComponent(profileMatch[1]);
      let foundRef: string | null = null;
      for (const [ref, profile] of this.profiles) {
        if (profile.iccid === iccid) { foundRef = ref; break; }
      }
      if (!foundRef) throw new EsimProviderError("NOT_FOUND", `Profile not found: ${iccid}`);
      const existing = this.profiles.get(foundRef)!;
      const updated = { ...existing, ...input.body };
      this.profiles.set(foundRef, updated);
      return updated as T;
    }

    // DELETE /profiles/{iccid} — release
    if (input.method === "DELETE" && profileMatch && !usageMatch) {
      const iccid = decodeURIComponent(profileMatch[1]);
      let foundRef: string | null = null;
      for (const [ref, profile] of this.profiles) {
        if (profile.iccid === iccid) { foundRef = ref; break; }
      }
      if (foundRef) this.profiles.delete(foundRef);
      return null;
    }

    throw new EsimProviderError("PERMANENT", `Unhandled: ${input.method} ${input.path}`);
  }
}
