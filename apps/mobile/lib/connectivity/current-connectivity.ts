/**
 * Phase 9.2 — Current Connectivity (mobile client)
 *
 * Fetches and caches the read-only CurrentConnectivity projection from the
 * server. The mobile UI consumes this to display state — it has NO
 * control-plane authority.
 *
 * This module only fetches/caches. It does NOT import DecisionEngine,
 * ActionExecutor, Kernel, or adapter modules. It is strictly a read model.
 */

import { api, getSession } from "../api";
import type { CurrentConnectivity } from "@roamlink/shared";

let cached: CurrentConnectivity | null = null;
let cachedAt: number = 0;
const CACHE_TTL_MS = 15_000; // 15 seconds — balance freshness vs. server load

/**
 * Fetch the current connectivity state from the server.
 * Returns cached data if fresh (within CACHE_TTL_MS).
 */
export async function getCurrentConnectivity(force = false): Promise<CurrentConnectivity | null> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const token = await getSession();
  if (!token) return null;

  try {
    const result = await api.getCurrentConnectivity(token);
    cached = result;
    cachedAt = now;
    return result;
  } catch (err) {
    console.warn("[current-connectivity] fetch failed:", err);
    return cached; // return stale cache on error
  }
}

/**
 * Clear the cache (on logout / session change).
 */
export function clearCurrentConnectivityCache(): void {
  cached = null;
  cachedAt = 0;
}
