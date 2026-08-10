/**
 * eSIM detail — usage, QR code, activation details, install steps, top-up.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert, RefreshControl } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Wifi, Clock, QrCode, Copy, Plus, Zap, RefreshCw, Smartphone } from "lucide-react-native";
import type { ESIM } from "@roamlink/shared";
import { formatDataSize, formatDate, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../lib/api";

export default function EsimDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [esim, setEsim] = useState<ESIM | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getSession();
      if (!token) return;
      const res = await api.getESIM(token, id);
      setEsim(res.esim);
    } catch { /* */ } finally { setLoading(false); setRefreshing(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function simulateUsage(usedMB: number) {
    setSimulating(true);
    try {
      const token = await getSession();
      if (!token) return;
      const res = await api.simulateUsage(token, id, usedMB);
      setEsim((e) => e ? { ...e, dataRemaining: res.result.dataRemainingMB, status: res.result.status as any } : e);
      Alert.alert("Usage simulated", `Used ${formatDataSize(usedMB)}`);
    } catch { /* */ } finally { setSimulating(false); }
  }

  function copy(text: string, label: string) {
    // Clipboard would use expo-clipboard in production
    Alert.alert("Copied", `${label} copied to clipboard`);
  }

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;
  if (!esim) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>eSIM not found</Text></View>;

  const usedPct = esim.dataAmount > 0 ? Math.round(((esim.dataAmount - esim.dataRemaining) / esim.dataAmount) * 100) : 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#f8faf9" }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      <View style={{ padding: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <Text style={{ fontSize: 40 }}>{countryFlag(esim.order.plan.countryCode)}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontWeight: "bold" }}>{esim.order.plan.country}</Text>
            <Text style={{ fontSize: 13, color: "#64748b" }}>{esim.order.plan.name}</Text>
          </View>
          <View style={{ backgroundColor: "#10b98120", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
            <Text style={{ color: "#10b981", fontSize: 11, fontWeight: "600", textTransform: "capitalize" }}>{esim.status}</Text>
          </View>
        </View>

        {/* Usage */}
        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 16 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Text style={{ fontSize: 16, fontWeight: "600" }}>Data usage</Text>
            <Pressable onPress={() => { setRefreshing(true); load(); }}>
              <RefreshCw size={16} color="#0d9488" />
            </Pressable>
          </View>
          <Text style={{ fontSize: 32, fontWeight: "bold" }}>{formatDataSize(esim.dataRemaining)}</Text>
          <Text style={{ fontSize: 13, color: "#64748b" }}>remaining of {formatDataSize(esim.dataAmount)}</Text>
          <View style={{ height: 8, backgroundColor: "#f1f5f9", borderRadius: 4, marginTop: 10 }}>
            <View style={{ height: 8, backgroundColor: "#0d9488", borderRadius: 4, width: `${100 - usedPct}%` }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
            <Text style={{ fontSize: 11, color: "#94a3b8" }}>{usedPct}% used</Text>
            <Text style={{ fontSize: 11, color: "#94a3b8" }}>{100 - usedPct}% remaining</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
            <Clock size={14} color="#64748b" />
            <Text style={{ fontSize: 13, color: "#64748b" }}>{esim.expiresAt ? `Expires ${formatDate(esim.expiresAt)}` : "No expiry"} · {esim.validityDays}d plan</Text>
          </View>

          {/* Dev: simulate usage */}
          {esim.provider === "mock" && esim.status === "active" && (
            <View style={{ marginTop: 14, padding: 12, backgroundColor: "#f0fdfa", borderRadius: 10, borderWidth: 1, borderColor: "#0d9488", borderStyle: "dashed" }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#0d9488" }}>Dev: simulate usage</Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                {[100, 500, 1024, 2048].map((mb) => (
                  <Pressable key={mb} onPress={() => simulateUsage(mb)} disabled={simulating} style={{ backgroundColor: "white", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                    <Text style={{ fontSize: 12, color: "#0d9488", fontWeight: "500" }}>{formatDataSize(mb)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Installation */}
        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 12 }}>Install your eSIM</Text>
          {esim.provider === "mock" && (
            <Text style={{ fontSize: 12, color: "#f59e0b", marginBottom: 8 }}>⚠ Development eSIM — test values, not a real carrier.</Text>
          )}
          {esim.qrCode && (
            <View style={{ alignItems: "center", marginBottom: 12 }}>
              <Image source={{ uri: esim.qrCode }} style={{ width: 200, height: 200, borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0" }} />
            </View>
          )}
          <Field label="SM-DP+ address" value={esim.smdpAddress} onCopy={() => copy(esim.smdpAddress ?? "", "SM-DP+ address")} />
          <Field label="Activation code" value={esim.activationCode} onCopy={() => copy(esim.activationCode ?? "", "Activation code")} />
          {esim.matchId && <Field label="Match ID" value={esim.matchId} onCopy={() => copy(esim.matchId, "Match ID")} />}
        </View>

        {/* Installation steps */}
        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 10 }}>Installation steps</Text>
          <Step n={1} text="Settings → Cellular → Add eSIM" />
          <Step n={2} text="Scan the QR code above" />
          <Step n={3} text="Label your eSIM (e.g. 'Travel data')" />
          <Step n={4} text="Select it as your data line" />
          <Step n={5} text="Enable data roaming, then connect" />
        </View>

        {esim.status === "active" && (
          <Pressable onPress={() => router.push(`/topup/${esim.id}`)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "white", paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: "#0d9488" }}>
            <Plus size={18} color="#0d9488" />
            <Text style={{ color: "#0d9488", fontSize: 16, fontWeight: "600" }}>Buy a top-up</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

import { Image } from "react-native";

function Field({ label, value, onCopy }: { label: string; value: string | null; onCopy: () => void }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={{ fontSize: 11, color: "#94a3b8" }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, fontFamily: "monospace", backgroundColor: "#f8faf9", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }} numberOfLines={1}>{value || "—"}</Text>
        <Pressable onPress={onCopy} disabled={!value}>
          <Copy size={16} color="#64748b" />
        </Pressable>
      </View>
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: "#0d948820", justifyContent: "center", alignItems: "center" }}>
        <Text style={{ fontSize: 11, fontWeight: "bold", color: "#0d9488" }}>{n}</Text>
      </View>
      <Text style={{ fontSize: 14, color: "#64748b", flex: 1 }}>{text}</Text>
    </View>
  );
}
