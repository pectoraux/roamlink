/**
 * Phase 9.1 — Connectivity State
 *
 * Captures what the device observes about its current connectivity.
 * Uses expo-network for transport + signal. Throughput/latency are
 * optionally measured via a lightweight HTTP probe (not carrier-specific APIs).
 */

import * as Network from "expo-network";
import type { EdgeConnectivityState } from "@roamlink/shared";

export async function getCurrentConnectivity(): Promise<EdgeConnectivityState> {
  const state = await Network.getNetworkStateAsync();

  return {
    transport: state.type === Network.NetworkStateType.WIFI ? "WIFI"
      : state.type === Network.NetworkStateType.CELLULAR ? "CELLULAR"
      : state.type === Network.NetworkStateType.ETHERNET ? "ETHERNET"
      : "UNKNOWN",
    connected: state.isConnected && state.isInternetReachable,
    signalQuality: undefined, // expo-network doesn't expose signal quality directly
  };
}

/**
 * Optional: measure latency + throughput via a lightweight probe to the
 * RoamLink backend. This is a PROBE source observation, not DEVICE.
 *
 * Kept separate from getCurrentConnectivity() so the caller can decide
 * whether to include probe data.
 */
export async function probeConnectivity(baseUrl: string): Promise<{
  latencyMs?: number;
  downlinkMbps?: number;
}> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/health`, { method: "GET" });
    const latencyMs = Date.now() - start;
    // Estimate downlink from response size + time (very rough)
    const text = await res.text();
    const bytes = text.length;
    const seconds = latencyMs / 1000;
    const downlinkMbps = seconds > 0 ? (bytes * 8) / (seconds * 1_000_000) : undefined;
    return { latencyMs, downlinkMbps };
  } catch {
    return {};
  }
}
