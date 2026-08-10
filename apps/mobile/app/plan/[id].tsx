/**
 * Plan detail — shows plan info + Buy button.
 */

import { useState, useEffect } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Wifi, Clock, Smartphone, Signal, ShieldCheck, ChevronLeft } from "lucide-react-native";
import type { PublicPlan } from "@roamlink/shared";
import { formatPrice, formatDataSize, countryFlag } from "@roamlink/shared";
import { api } from "../../lib/api";

export default function PlanDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [plan, setPlan] = useState<PublicPlan | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPlan(id).then((d) => setPlan(d.plan)).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;
  if (!plan) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>Plan not found</Text></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <Text style={{ fontSize: 48 }}>{countryFlag(plan.countryCode)}</Text>
          <View>
            <Text style={{ fontSize: 24, fontWeight: "bold" }}>{plan.country}</Text>
            <Text style={{ fontSize: 14, color: "#64748b" }}>{plan.name}</Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 10, marginBottom: 20 }}>
          <Stat icon={Wifi} label="Data" value={formatDataSize(plan.dataAmountMB)} />
          <Stat icon={Clock} label="Validity" value={`${plan.validityDays}d`} />
          <Stat icon={Signal} label="Speed" value={plan.speed || "4G"} />
        </View>

        {plan.description && <Text style={{ fontSize: 14, color: "#64748b", marginBottom: 20 }}>{plan.description}</Text>}

        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 10 }}>Coverage & networks</Text>
          <Text style={{ fontSize: 14, color: "#64748b", marginBottom: 8 }}>{plan.coverage || plan.country}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {plan.networks.map((n) => (
              <View key={n} style={{ backgroundColor: "#f1f5f9", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                <Text style={{ fontSize: 12 }}>{n}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18, marginBottom: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 10 }}>Features</Text>
          <Feature ok={true} label={`${plan.speed || "4G/5G"} network speeds`} />
          <Feature ok={plan.hotspot} label="Hotspot / tethering" />
          <Feature ok={plan.topUpSupported} label="Top-up available" />
          <Feature ok={true} label="Install via QR code" />
        </View>
      </View>

      <View style={{ padding: 20, backgroundColor: "white", borderTopWidth: 1, borderTopColor: "#e2e8f0" }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Text style={{ fontSize: 28, fontWeight: "bold" }}>{formatPrice(plan.priceMinor, plan.currency)}</Text>
          <Text style={{ fontSize: 14, color: "#64748b" }}>one-time</Text>
        </View>
        <Pressable
          onPress={() => router.push(`/checkout/${plan.id}`)}
          style={{ backgroundColor: "#0d9488", paddingVertical: 16, borderRadius: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
        >
          <Text style={{ color: "white", fontSize: 18, fontWeight: "600" }}>Buy eSIM</Text>
        </Pressable>
        <Text style={{ textAlign: "center", fontSize: 12, color: "#64748b", marginTop: 10 }}>Secure checkout · Instant activation</Text>
      </View>
    </ScrollView>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: "white", borderRadius: 12, padding: 12, alignItems: "center" }}>
      <Icon size={18} color="#0d9488" />
      <Text style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: "600" }}>{value}</Text>
    </View>
  );
}

function Feature({ ok, label }: { ok: boolean; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <Text style={{ color: ok ? "#10b981" : "#cbd5e1", fontSize: 16 }}>{ok ? "✓" : "—"}</Text>
      <Text style={{ fontSize: 14, color: ok ? "#0f172a" : "#94a3b8", textDecorationLine: ok ? "none" : "line-through" }}>{label}</Text>
    </View>
  );
}
