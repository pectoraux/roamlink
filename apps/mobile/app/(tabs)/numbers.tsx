/**
 * Numbers tab — shows user's virtual numbers + browse countries.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { Phone, Plus, MessageSquare, ChevronRight } from "lucide-react-native";
import type { VirtualNumber, NumberCountry } from "@roamlink/shared";
import { formatPrice, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../../lib/api";

export default function NumbersScreen() {
  const router = useRouter();
  const [numbers, setNumbers] = useState<VirtualNumber[]>([]);
  const [countries, setCountries] = useState<NumberCountry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<"my" | "browse">("my");

  const load = useCallback(async () => {
    try {
      const token = await getSession();
      const [vnRes, countryRes] = await Promise.all([
        token ? api.listNumbers(token) : Promise.resolve({ numbers: [] as VirtualNumber[] }),
        api.getVNCountries(),
      ]);
      setNumbers(vnRes.numbers);
      setCountries(countryRes.countries);
    } catch { /* */ } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  const statusColors: Record<string, string> = {
    active: "#10b981", suspended: "#f59e0b", released: "#64748b", failed: "#ef4444",
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 24, fontWeight: "bold" }}>Numbers</Text>
        <Pressable onPress={() => setView(view === "my" ? "browse" : "my")}>
          <Text style={{ color: "#0d9488", fontWeight: "600" }}>{view === "my" ? "Browse" : "My Numbers"}</Text>
        </Pressable>
      </View>

      {view === "my" ? (
        numbers.length === 0 ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
            <Phone size={48} color="#cbd5e1" />
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#64748b", marginTop: 12 }}>No numbers yet</Text>
            <Text style={{ fontSize: 14, color: "#94a3b8", textAlign: "center", marginTop: 4 }}>Browse available countries and get your first virtual number.</Text>
            <Pressable onPress={() => setView("browse")} style={{ marginTop: 20, backgroundColor: "#0d9488", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 }}>
              <Text style={{ color: "white", fontWeight: "600" }}>Browse numbers</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={numbers}
            keyExtractor={(item) => item.id}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
            renderItem={({ item }) => (
              <Pressable onPress={() => router.push(`/number/${item.id}`)} style={{ backgroundColor: "white", marginHorizontal: 20, marginBottom: 12, padding: 18, borderRadius: 16 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <Text style={{ fontSize: 28 }}>{countryFlag(item.countryCode)}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: "600", fontFamily: "monospace" }}>{item.e164}</Text>
                    <Text style={{ fontSize: 12, color: "#64748b" }}>{item.country} · {item.region ?? "Local"}</Text>
                  </View>
                  <View style={{ backgroundColor: (statusColors[item.status] || "#64748b") + "20", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
                    <Text style={{ color: statusColors[item.status] || "#64748b", fontSize: 11, fontWeight: "600", textTransform: "capitalize" }}>{item.status}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 12, marginTop: 10 }}>
                  {item.smsEnabled && <Text style={{ fontSize: 11, color: "#64748b" }}>💬 SMS</Text>}
                  {item.voiceEnabled && <Text style={{ fontSize: 11, color: "#64748b" }}>📞 Voice</Text>}
                  <Text style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>{formatPrice(item.sellingPrice, item.currency)}/mo</Text>
                </View>
              </Pressable>
            )}
          />
        )
      ) : (
        <FlatList
          data={countries}
          keyExtractor={(item) => item.countryCode}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/number-search/${item.countryCode}`)} style={{ flexDirection: "row", alignItems: "center", backgroundColor: "white", marginHorizontal: 20, marginBottom: 10, padding: 16, borderRadius: 14, gap: 12 }}>
              <Text style={{ fontSize: 28 }}>{countryFlag(item.countryCode)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: "600" }}>{item.country}</Text>
                <Text style={{ fontSize: 13, color: "#64748b" }}>{item.count} numbers · {item.sms ? "SMS" : ""} {item.voice ? "Voice" : ""}</Text>
              </View>
              <ChevronRight size={20} color="#cbd5e1" />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
