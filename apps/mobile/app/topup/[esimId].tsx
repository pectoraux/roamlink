/**
 * Top-up screen — shows available packages and lets the user purchase.
 */

import { useState, useEffect } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert, FlatList } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Plus } from "lucide-react-native";
import type { TopUpPackage } from "@roamlink/shared";
import { formatPrice, formatDataSize, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../lib/api";

export default function TopUpScreen() {
  const { esimId } = useLocalSearchParams<{ esimId: string }>();
  const router = useRouter();
  const [packages, setPackages] = useState<TopUpPackage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [esimCountry, setEsimCountry] = useState("");

  useEffect(() => {
    (async () => {
      const token = await getSession();
      if (!token) { router.push("/login"); return; }
      try {
        const [pkgRes, esimRes] = await Promise.all([
          api.getTopUpPackages(token, esimId),
          api.getESIM(token, esimId),
        ]);
        setPackages(pkgRes.packages);
        setEsimCountry(esimRes.esim.order.plan.country);
        if (pkgRes.packages[0]) setSelected(pkgRes.packages[0].id);
      } catch { /* */ } finally { setLoading(false); }
    })();
  }, [esimId, router]);

  async function purchase() {
    if (!selected) return;
    setPurchasing(true);
    try {
      const token = await getSession();
      if (!token) return;
      const res = await api.purchaseTopUp(token, esimId, selected, `topup_${esimId}_${Date.now()}`);
      Alert.alert("Top-up successful! 🎉", `Data added to your eSIM.`);
      router.back();
    } catch (e: any) {
      Alert.alert("Top-up failed", e.message || "Please try again");
    } finally {
      setPurchasing(false);
    }
  }

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  if (packages.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: "#f8faf9", justifyContent: "center", alignItems: "center", padding: 40 }}>
        <Plus size={48} color="#cbd5e1" />
        <Text style={{ fontSize: 16, fontWeight: "600", color: "#64748b", marginTop: 12 }}>Top-ups not available</Text>
        <Text style={{ fontSize: 14, color: "#94a3b8", textAlign: "center", marginTop: 4 }}>This eSIM doesn't support top-ups.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: "bold" }}>Top up your eSIM</Text>
        <Text style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>{esimCountry}</Text>
      </View>
      <FlatList
        data={packages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => setSelected(item.id)}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: "white", padding: 16, borderRadius: 14, marginBottom: 10, borderWidth: 2, borderColor: selected === item.id ? "#0d9488" : "transparent" }}
          >
            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selected === item.id ? "#0d9488" : "#cbd5e1", justifyContent: "center", alignItems: "center", marginRight: 12 }}>
              {selected === item.id && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#0d9488" }} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: "600" }}>{item.name}</Text>
              <Text style={{ fontSize: 13, color: "#64748b" }}>{formatDataSize(item.dataAmountMB)}{item.validityDays ? ` · ${item.validityDays} days` : ""}</Text>
            </View>
            <Text style={{ fontSize: 18, fontWeight: "bold", color: "#0d9488" }}>{formatPrice(item.priceMinor, item.currency)}</Text>
          </Pressable>
        )}
      />
      <View style={{ padding: 20, backgroundColor: "white", borderTopWidth: 1, borderTopColor: "#e2e8f0" }}>
        <Pressable onPress={purchase} disabled={!selected || purchasing} style={{ backgroundColor: "#0d9488", paddingVertical: 16, borderRadius: 14, alignItems: "center" }}>
          {purchasing ? <ActivityIndicator color="white" /> : <Text style={{ color: "white", fontSize: 18, fontWeight: "600" }}>Pay & top up</Text>}
        </Pressable>
      </View>
    </View>
  );
}
