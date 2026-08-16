/**
 * Home — Current Connectivity primary + destinations.
 *
 * Phase 9.2: The top-level object is now "Current Connectivity" (read-only
 * control-plane view). The eSIM card remains as a secondary resource detail,
 * shown only when the current resource happens to be an eSIM.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, TextInput, Pressable, FlatList, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { Search, Zap, Plus } from "lucide-react-native";
import type { PublicPlan, ESIM, CurrentConnectivity } from "@roamlink/shared";
import { formatPrice, formatDataSize, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { getCurrentConnectivity } from "../../../lib/connectivity/current-connectivity";
import { CurrentConnectivityCard } from "../../../components/connectivity/CurrentConnectivityCard";

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [destinations, setDestinations] = useState<{ country: string; countryCode: string; minPriceMinor: number }[]>([]);
  const [esims, setEsims] = useState<ESIM[]>([]);
  const [currentConnectivity, setCurrentConnectivity] = useState<CurrentConnectivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const token = await getSession();
      const [plansRes, esimRes, currentRes] = await Promise.all([
        api.getPlans(),
        token ? api.listESIMs(token) : Promise.resolve({ esims: [] as ESIM[] }),
        token ? getCurrentConnectivity(true) : Promise.resolve(null),
      ]);
      setDestinations(plansRes.destinations);
      setEsims(esimRes.esims);
      setCurrentConnectivity(currentRes);
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Refresh current connectivity every 30s (read-only polling)
  useEffect(() => {
    const interval = setInterval(async () => {
      const current = await getCurrentConnectivity();
      if (current) setCurrentConnectivity(current);
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const activeESIM = esims.find((e) => e.status === "active");

  function search() {
    if (query.trim()) {
      router.push(`/explore?q=${encodeURIComponent(query)}`);
    } else {
      router.push("/explore");
    }
  }

  if (loading) {
    return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <FlatList
        data={destinations}
        keyExtractor={(item) => item.countryCode}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} />}
        ListHeaderComponent={
          <View style={{ padding: 20 }}>
            <Text style={{ fontSize: 28, fontWeight: "bold", color: "#0f172a", marginBottom: 4 }}>Hi, {user?.name?.split(" ")[0] || "Traveler"} 👋</Text>
            <Text style={{ fontSize: 16, color: "#64748b", marginBottom: 20 }}>Where are you going?</Text>

            {/* Phase 9.2: Current Connectivity is the primary view */}
            {currentConnectivity && (
              <View style={{ marginBottom: 24 }}>
                <CurrentConnectivityCard data={currentConnectivity} />
              </View>
            )}

            {/* Search */}
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "white", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 4, marginBottom: 24, shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 }}>
              <Search size={20} color="#94a3b8" />
              <TextInput
                style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 10, fontSize: 16 }}
                placeholder="Search a destination..."
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={search}
                returnKeyType="search"
              />
            </View>

            {/* Active eSIM card (secondary — shown when current resource is eSIM) */}
            {activeESIM && (
              <Pressable
                onPress={() => router.push(`/esim/${activeESIM.id}`)}
                style={{ backgroundColor: "#0d9488", borderRadius: 18, padding: 20, marginBottom: 24 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
                  <Text style={{ fontSize: 32 }}>{countryFlag(activeESIM.order.plan.countryCode)}</Text>
                  <View style={{ marginLeft: 12, flex: 1 }}>
                    <Text style={{ fontSize: 18, fontWeight: "bold", color: "white" }}>{activeESIM.order.plan.country}</Text>
                    <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.8)" }}>{activeESIM.order.plan.name}</Text>
                  </View>
                  <View style={{ backgroundColor: "rgba(255,255,255,0.2", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
                    <Text style={{ color: "white", fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>{activeESIM.status}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
                  <View>
                    <Text style={{ fontSize: 28, fontWeight: "bold", color: "white" }}>{formatDataSize(activeESIM.dataRemaining)}</Text>
                    <Text style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>remaining of {formatDataSize(activeESIM.dataAmount)}</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable onPress={() => router.push(`/topup/${activeESIM.id}`)} style={{ backgroundColor: "rgba(255,255,255,0.2)", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
                      <Text style={{ color: "white", fontSize: 13, fontWeight: "600" }}>Top up</Text>
                    </Pressable>
                    <Pressable onPress={() => router.push(`/esim/${activeESIM.id}`)} style={{ backgroundColor: "white", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
                      <Text style={{ color: "#0d9488", fontSize: 13, fontWeight: "600" }}>Manage</Text>
                    </Pressable>
                  </View>
                </View>
              </Pressable>
            )}

            {/* Quick action: buy new */}
            {!activeESIM && (
              <Pressable onPress={() => router.push("/explore")} style={{ backgroundColor: "white", borderRadius: 16, padding: 20, marginBottom: 24, alignItems: "center", borderWidth: 1, borderColor: "#0d9488", borderStyle: "dashed" }}>
                <Plus size={24} color="#0d9488" />
                <Text style={{ fontSize: 16, fontWeight: "600", color: "#0d9488", marginTop: 8 }}>Buy your first eSIM</Text>
                <Text style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>Choose from 190+ destinations</Text>
              </Pressable>
            )}

            <Text style={{ fontSize: 18, fontWeight: "bold", color: "#0f172a", marginBottom: 12 }}>Popular destinations</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/explore?country=${item.countryCode}`)}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: "white", marginHorizontal: 20, marginBottom: 10, padding: 16, borderRadius: 14, gap: 12 }}
          >
            <Text style={{ fontSize: 28 }}>{countryFlag(item.countryCode)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: "#0f172a" }}>{item.country}</Text>
              <Text style={{ fontSize: 13, color: "#64748b" }}>from {formatPrice(item.minPriceMinor)}</Text>
            </View>
            <Zap size={16} color="#0d9488" />
          </Pressable>
        )}
        ListFooterComponent={<View style={{ height: 40 }} />}
      />
    </View>
  );
}
