/**
 * Phase 9.2 — Connectivity Health Badge
 *
 * Displays the health status (Healthy / Degraded / Unknown) with color.
 * Read-only — no actions.
 */

import { View, Text } from "react-native";
import type { CurrentConnectivityHealth } from "@roamlink/shared";

export function ConnectivityHealth({ health }: { health: CurrentConnectivityHealth | null }) {
  if (!health) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#94a3b8" }} />
        <Text style={{ color: "#64748b", fontSize: 13 }}>Unknown</Text>
      </View>
    );
  }

  const color = health.status === "HEALTHY" ? "#22c55e" : health.status === "DEGRADED" ? "#f59e0b" : "#94a3b8";
  const label = health.status === "HEALTHY" ? "Healthy" : health.status === "DEGRADED" ? "Degraded" : "Unknown";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "600" }}>{label}</Text>
      {health.freshness === "STALE" && (
        <Text style={{ color: "#94a3b8", fontSize: 11 }}>· stale</Text>
      )}
      {health.freshness === "EXPIRED" && (
        <Text style={{ color: "#ef4444", fontSize: 11 }}>· re-observing</Text>
      )}
    </View>
  );
}
