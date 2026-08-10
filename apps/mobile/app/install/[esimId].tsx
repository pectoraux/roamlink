/**
 * Install screen — post-purchase installation flow.
 * Shows the eSIM QR code + step-by-step installation guide.
 */

import { useState, useEffect } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CheckCircle2, Copy } from "lucide-react-native";
import type { ESIM } from "@roamlink/shared";
import { formatDataSize, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../lib/api";

export default function InstallScreen() {
  const { esimId } = useLocalSearchParams<{ esimId: string }>();
  const router = useRouter();
  const [esim, setEsim] = useState<ESIM | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = await getSession();
      if (!token) { router.push("/login"); return; }
      try {
        const res = await api.getESIM(token, esimId);
        setEsim(res.esim);
      } catch { /* */ } finally { setLoading(false); }
    })();
  }, [esimId, router]);

  function copy(text: string, label: string) {
    Alert.alert("Copied", `${label} copied to clipboard`);
  }

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;
  if (!esim) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>eSIM not found</Text></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20, alignItems: "center" }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#10b98120", justifyContent: "center", alignItems: "center" }}>
          <CheckCircle2 size={32} color="#10b981" />
        </View>
        <Text style={{ fontSize: 24, fontWeight: "bold", marginTop: 12 }}>Your eSIM is ready</Text>
        <Text style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>Follow these steps to install</Text>
      </View>

      <View style={{ padding: 20 }}>
        {/* eSIM info */}
        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 16, alignItems: "center" }}>
          <Text style={{ fontSize: 48 }}>{countryFlag(esim.order.plan.countryCode)}</Text>
          <Text style={{ fontSize: 18, fontWeight: "bold", marginTop: 8 }}>{esim.order.plan.country}</Text>
          <Text style={{ fontSize: 14, color: "#64748b" }}>{formatDataSize(esim.dataAmount)} · {esim.validityDays} days</Text>
        </View>

        {/* QR code */}
        {esim.qrCode && (
          <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 16, alignItems: "center" }}>
            <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 12 }}>Scan to install</Text>
            <Image source={{ uri: esim.qrCode }} style={{ width: 220, height: 220, borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0" }} />
          </View>
        )}

        {/* Activation details */}
        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 10 }}>Or enter manually</Text>
          <Field label="SM-DP+ address" value={esim.smdpAddress} onCopy={() => copy(esim.smdpAddress ?? "", "SM-DP+ address")} />
          <Field label="Activation code" value={esim.activationCode} onCopy={() => copy(esim.activationCode ?? "", "Activation code")} />
          {esim.matchId && <Field label="Match ID" value={esim.matchId} onCopy={() => copy(esim.matchId, "Match ID")} />}
        </View>

        {/* Steps */}
        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 12 }}>Installation steps</Text>
          {[
            "Open Settings → Cellular → Add eSIM",
            "Scan the QR code, or enter details manually",
            "Label your eSIM (e.g. 'Ghana travel')",
            "Select it as your data line",
            "Enable data roaming if required",
            "Connect — activation completes on the network",
          ].map((step, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 10, paddingVertical: 5 }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#0d948820", justifyContent: "center", alignItems: "center" }}>
                <Text style={{ fontSize: 12, fontWeight: "bold", color: "#0d9488" }}>{i + 1}</Text>
              </View>
              <Text style={{ fontSize: 14, color: "#64748b", flex: 1 }}>{step}</Text>
            </View>
          ))}
        </View>

        <Pressable onPress={() => router.replace("/(tabs)/esims")} style={{ backgroundColor: "#0d9488", paddingVertical: 16, borderRadius: 14, alignItems: "center" }}>
          <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>Done — View My eSIMs</Text>
        </Pressable>
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
        <Pressable onPress={onCopy} disabled={!value}><Copy size={16} color="#64748b" /></Pressable>
      </View>
    </View>
  );
}
