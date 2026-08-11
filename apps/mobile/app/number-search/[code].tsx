/**
 * Number search — browse available numbers in a country.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, MessageSquare, Phone, Smartphone } from "lucide-react-native";
import type { ProviderNumber } from "@roamlink/shared";
import { formatPrice, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export default function NumberSearchScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [numbers, setNumbers] = useState<ProviderNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.searchVNNumbers({ countryCode: code, smsRequired: true });
      setNumbers(res.numbers);
    } catch { /* */ } finally { setLoading(false); }
  }, [code]);

  useEffect(() => { load(); }, [load]);

  async function purchase(num: ProviderNumber) {
    if (!user) { router.push("/login"); return; }
    setPurchasing(num.providerNumberId);
    try {
      const token = await getSession();
      if (!token) return;
      const res = await api.purchaseNumber(token, num.providerNumberId, `vn_mobile_${num.providerNumberId}_${Date.now()}`);
      Alert.alert("Success!", "Your number is ready.");
      router.replace(`/number/${res.virtualNumberId}`);
    } catch (e: any) {
      Alert.alert("Purchase failed", e.message || "Please try again");
    } finally {
      setPurchasing(null);
    }
  }

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: "bold" }}>{countryFlag(code)} Numbers</Text>
        <Text style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>{numbers.length} available</Text>
      </View>
      <FlatList
        data={numbers}
        keyExtractor={(item) => item.providerNumberId}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: "white", padding: 18, borderRadius: 16, marginBottom: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
              <View>
                <Text style={{ fontSize: 20, fontWeight: "bold", fontFamily: "monospace" }}>{item.e164}</Text>
                <Text style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{item.region ?? item.city ?? "Local"}</Text>
              </View>
              <Text style={{ fontSize: 28 }}>{countryFlag(item.countryCode)}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              {item.smsEnabled && <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><MessageSquare size={14} color="#64748b" /><Text style={{ fontSize: 11, color: "#64748b" }}>SMS</Text></View>}
              {item.voiceEnabled && <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><Phone size={14} color="#64748b" /><Text style={{ fontSize: 11, color: "#64748b" }}>Voice</Text></View>}
              {item.mmsEnabled && <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><Smartphone size={14} color="#64748b" /><Text style={{ fontSize: 11, color: "#64748b" }}>MMS</Text></View>}
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#f1f5f9" }}>
              <View>
                <Text style={{ fontSize: 18, fontWeight: "bold", color: "#0d9488" }}>{formatPrice(item.sellingPriceMinor, item.currency)}</Text>
                <Text style={{ fontSize: 11, color: "#94a3b8" }}>/month</Text>
              </View>
              <Pressable
                onPress={() => purchase(item)}
                disabled={purchasing === item.providerNumberId}
                style={{ backgroundColor: "#0d9488", paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                {purchasing === item.providerNumberId ? <ActivityIndicator color="white" size="small" /> : <><Check size={16} color="white" /><Text style={{ color: "white", fontWeight: "600" }}>Get number</Text></>}
              </Pressable>
            </View>
          </View>
        )}
      />
    </View>
  );
}
