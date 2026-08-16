/**
 * Phase 9.2 — Connectivity Decision Status
 *
 * Displays what RoamLink is currently doing (optimizing, switching, monitoring).
 * Read-only — no actions.
 */

import { View, Text } from "react-native";
import type { CurrentConnectivityDecision } from "@roamlink/shared";

export function ConnectivityDecisionStatus({ decision }: { decision: CurrentConnectivityDecision | null }) {
  if (!decision) {
    return (
      <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#e2e8f0" }}>
        <Text style={{ color: "#64748b", fontSize: 12 }}>RoamLink status</Text>
        <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "500", marginTop: 2 }}>Monitoring</Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#e2e8f0" }}>
      <Text style={{ color: "#64748b", fontSize: 12 }}>RoamLink status</Text>
      <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "500", marginTop: 2 }}>
        {decision.statusLabel}
      </Text>
      {decision.reasons.length > 0 && (
        <Text style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
          {decision.reasons[0]}
        </Text>
      )}
    </View>
  );
}
