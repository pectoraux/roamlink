/**
 * My eSIMs — list of all user's eSIMs with status badges.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { Smartphone, Plus } from "lucide-react-native";
import type { ESIM } from "@roamlink/shared";
import { formatDataSize, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../../lib/api";

export default function EsimsScreen() {
  const router = useRouter();
  const [esims, setEsims] = useState<ESIM[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getSession();
      if (!token) return;
      const res = await api.listESIMs(token);
      setEsims(res.esims);
    } catch { /* */ } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  const statusColors: Record<string, string> = {
    active: "#10b981", expired: "#ef4444", exhausted: "#f59e0b", suspended: "#f97316", cancelled: "#64748b", pending: "#f59e0b",
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 24, fontWeight: "bold" }}>My eSIMs</Text>
        <Pressable onPress={() => router.push("/explore")} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Plus size={18} color="#0d9488" />
          <Text style={{ color: "#0d9488", fontWeight: "600" }}>New</Text>
        </Pressable>
      </View>
      {esims.length === 0 ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
          <Smartphone size={48} color="#cbd5e1" />
          <Text style={{ fontSize: 16, fontWeight: "600", color: "#64748b", marginTop: 12 }}>No eSIMs yet</Text>
          <Text style={{ fontSize: 14, color: "#94a3b8", textAlign: "center", marginTop: 4 }}>Browse plans and buy your first travel eSIM.</Text>
          <Pressable onPress={() => router.push("/explore")} style={{ marginTop: 20, backgroundColor: "#0d9488", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 }}>
            <Text style={{ color: "white", fontWeight: "600" }}>Browse plans</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={esims}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/esim/${item.id}`)} style={{ backgroundColor: "white", marginHorizontal: 20, marginBottom: 12, padding: 18, borderRadius: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                <Text style={{ fontSize: 32 }}>{countryFlag(item.order.plan.countryCode)}</Text>
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: "600" }}>{item.order.plan.country}</Text>
                  <Text style={{ fontSize: 12, color: "#64748b" }}>{item.order.plan.name}</Text>
                </View>
                <View style={{ backgroundColor: (statusColors[item.status] || "#64748b") + "20", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
                  <Text style={{ color: statusColors[item.status] || "#64748b", fontSize: 11, fontWeight: "600", textTransform: "capitalize" }}>{item.status}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 20, fontWeight: "bold" }}>{formatDataSize(item.dataRemaining)}</Text>
                <Text style={{ fontSize: 13, color: "#64748b" }}>of {formatDataSize(item.dataAmount)}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
