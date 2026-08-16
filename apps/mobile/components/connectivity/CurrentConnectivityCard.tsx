/**
 * Phase 9.2 — Current Connectivity Card
 *
 * The primary UI component showing what connectivity is serving the user now.
 * Read-only — no "Switch provider", "Activate eSIM", or provider-specific commands.
 *
 *   ┌──────────────────────────────┐
 *   │ Wi-Fi                        │
 *   │ RoamLink Zone • Accra        │
 *   │                              │
 *   │ 142 Mbps ↓   18 Mbps ↑      │
 *   │ 24 ms latency                │
 *   │ 0.4% packet loss             │
 *   │                              │
 *   │ ● Healthy                    │
 *   └──────────────────────────────┘
 */

import { View, Text } from "react-native";
import type { CurrentConnectivity } from "@roamlink/shared";
import { ConnectivityHealth } from "./ConnectivityHealth";
import { ConnectivityDecisionStatus } from "./ConnectivityDecisionStatus";

export function CurrentConnectivityCard({ data }: { data: CurrentConnectivity }) {
  // No active session
  if (!data.session) {
    return (
      <View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#e2e8f0" }}>
        <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 }}>
          Current Connectivity
        </Text>
        <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "600", marginTop: 8 }}>
          No active connectivity
        </Text>
        <Text style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
          RoamLink is not managing a connection right now.
        </Text>
      </View>
    );
  }

  const { session, capability, health, decision, transition } = data;

  return (
    <View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#e2e8f0" }}>
      <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Current Connectivity
      </Text>

      {/* Transport + location */}
      <View style={{ marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: "#0f172a", fontSize: 20, fontWeight: "700" }}>
          {capability?.transportLabel ?? "Connectivity"}
        </Text>
        <ConnectivityHealth health={health} />
      </View>

      {capability?.location?.city && (
        <Text style={{ color: "#64748b", fontSize: 13, marginTop: 2 }}>
          RoamLink Zone • {capability.location.city}
          {capability.location.country ? `, ${capability.location.country}` : ""}
        </Text>
      )}

      {/* Metrics */}
      {health && (
        <View style={{ marginTop: 12, gap: 4 }}>
          {health.bandwidthDownMbps !== undefined && (
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Text style={{ color: "#0f172a", fontSize: 14 }}>
                {Math.round(health.bandwidthDownMbps)} Mbps ↓
              </Text>
              {health.bandwidthUpMbps !== undefined && (
                <Text style={{ color: "#0f172a", fontSize: 14 }}>
                  {Math.round(health.bandwidthUpMbps)} Mbps ↑
                </Text>
              )}
            </View>
          )}
          {health.latencyMs !== undefined && (
            <Text style={{ color: "#64748b", fontSize: 13 }}>
              {Math.round(health.latencyMs)} ms latency
            </Text>
          )}
          {health.packetLossPct !== undefined && (
            <Text style={{ color: "#64748b", fontSize: 13 }}>
              {health.packetLossPct.toFixed(1)}% packet loss
            </Text>
          )}
        </View>
      )}

      {/* Health explanation */}
      {health?.explanation && (
        <Text style={{ color: "#64748b", fontSize: 12, marginTop: 8, fontStyle: "italic" }}>
          {health.explanation}
        </Text>
      )}

      {/* Transition (switch in progress, etc.) */}
      {transition && (
        <View style={{ marginTop: 8, padding: 8, backgroundColor: "#fef3c7", borderRadius: 6 }}>
          <Text style={{ color: "#92400e", fontSize: 12, fontWeight: "500" }}>
            {transition.description}
          </Text>
        </View>
      )}

      {/* Decision status */}
      <ConnectivityDecisionStatus decision={decision} />

      {/* Last observed */}
      {health?.observedAt && (
        <Text style={{ color: "#94a3b8", fontSize: 11, marginTop: 8 }}>
          Last measurement {timeAgo(health.observedAt)}
        </Text>
      )}
    </View>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours > 1 ? "s" : ""} ago`;
}
