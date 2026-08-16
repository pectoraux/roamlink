/**
 * Phase 9.3 — Connectivity Settings
 *
 * User-configurable policy preferences. These are CONTEXT hints sent to the
 * server — the server-side policy engine remains authoritative. The mobile
 * NEVER decides "switch to WiFi" — it only reports preferences.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, Pressable, Switch, ActivityIndicator, ScrollView } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import type { EdgePolicyContext } from "@roamlink/shared";
import { fetchPolicyContext, syncPolicyContext } from "../../lib/connectivity/policy-context";

const PREFERENCES: Array<{ key: keyof EdgePolicyContext; label: string; description: string }> = [
  { key: "autoSwitchEnabled", label: "Automatic Switching", description: "Let RoamLink switch connectivity automatically when quality degrades." },
  { key: "batterySaver", label: "Battery Saver Mode", description: "Minimize switching to conserve battery. Overrides auto-detected state." },
  { key: "workMode", label: "Work Mode", description: "Prefer reliable connections for work video calls." },
  { key: "avoidCellular", label: "Avoid Cellular", description: "Prefer WiFi over cellular when possible." },
  { key: "allowRoaming", label: "Allow Roaming", description: "Permit roaming connectivity when traveling." },
];

const PREFERENCE_OPTIONS: Array<{ value: NonNullable<EdgePolicyContext["connectivityPreference"]>; label: string }> = [
  { value: "BALANCED", label: "Balanced" },
  { value: "RELIABLE", label: "Reliable" },
  { value: "CHEAPEST", label: "Cheapest" },
  { value: "FASTEST", label: "Fastest" },
];

export default function ConnectivitySettingsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [context, setContext] = useState<EdgePolicyContext>({
    autoSwitchEnabled: true,
    batterySaver: false,
    workMode: false,
    avoidCellular: false,
    allowRoaming: true,
  });
  const [serverPolicy, setServerPolicy] = useState<{
    mode: string;
    preset: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    const result = await fetchPolicyContext();
    if (result) {
      setContext(prev => ({ ...prev, ...result.context }));
      setServerPolicy({ mode: result.policy.mode, preset: result.policy.preset });
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function updateAndSave(updates: Partial<EdgePolicyContext>) {
    const newContext = { ...context, ...updates };
    setContext(newContext);
    setSaving(true);
    await syncPolicyContext(newContext);
    // Refresh server policy to show what was applied
    const result = await fetchPolicyContext();
    if (result) {
      setServerPolicy({ mode: result.policy.mode, preset: result.policy.preset });
    }
    setSaving(false);
  }

  if (loading) {
    return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      {/* Header */}
      <View style={{ paddingTop: 60, paddingHorizontal: 20, paddingBottom: 20, flexDirection: "row", alignItems: "center" }}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ChevronLeft size={24} color="#0f172a" />
        </Pressable>
        <Text style={{ fontSize: 20, fontWeight: "700", color: "#0f172a", marginLeft: 8 }}>Connectivity Settings</Text>
        {saving && <ActivityIndicator size="small" color="#0d9488" style={{ marginLeft: 12 }} />}
      </View>

      {/* Server-applied policy status */}
      {serverPolicy && (
        <View style={{ marginHorizontal: 20, marginBottom: 20, padding: 16, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0" }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Server Policy</Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: "#94a3b8" }}>Mode</Text>
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#0f172a" }}>{serverPolicy.mode}</Text>
            </View>
            {serverPolicy.preset && (
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: "#94a3b8" }}>Preset</Text>
                <Text style={{ fontSize: 14, fontWeight: "600", color: "#0f172a" }}>{serverPolicy.preset}</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, fontStyle: "italic" }}>
            RoamLink applies these server-side. You report preferences; the server decides.
          </Text>
        </View>
      )}

      {/* Connectivity preference */}
      <View style={{ marginHorizontal: 20, marginBottom: 20 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: "#0f172a", marginBottom: 8 }}>Connectivity Preference</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {PREFERENCE_OPTIONS.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => updateAndSave({ connectivityPreference: opt.value })}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: context.connectivityPreference === opt.value ? "#0d9488" : "#fff",
                borderWidth: 1,
                borderColor: context.connectivityPreference === opt.value ? "#0d9488" : "#e2e8f0",
              }}
            >
              <Text style={{
                fontSize: 13,
                fontWeight: "600",
                color: context.connectivityPreference === opt.value ? "#fff" : "#0f172a",
              }}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Toggle preferences */}
      <View style={{ marginHorizontal: 20, marginBottom: 20 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: "#0f172a", marginBottom: 12 }}>Preferences</Text>
        {PREFERENCES.map((pref) => (
          <View key={pref.key} style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 12,
            paddingHorizontal: 16,
            backgroundColor: "#fff",
            borderRadius: 12,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: "#e2e8f0",
          }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#0f172a" }}>{pref.label}</Text>
              <Text style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{pref.description}</Text>
            </View>
            <Switch
              value={context[pref.key] as boolean}
              onValueChange={(value) => updateAndSave({ [pref.key]: value })}
              trackColor={{ false: "#e2e8f0", true: "#0d9488" }}
              thumbColor="#fff"
            />
          </View>
        ))}
      </View>

      {/* Footer note */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 40 }}>
        <Text style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", fontStyle: "italic" }}>
          These preferences are hints. RoamLink's server-side policy engine makes the final decision — the mobile app never switches connectivity on its own.
        </Text>
      </View>
    </ScrollView>
  );
}
