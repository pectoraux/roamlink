/**
 * Activity — recent orders.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, FlatList, ActivityIndicator, RefreshControl } from "react-native";
import type { Order } from "@roamlink/shared";
import { formatPrice, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../../lib/api";

export default function ActivityScreen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getSession();
      if (!token) return;
      const res = await api.listOrders(token);
      setOrders(res.orders);
    } catch { /* */ } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: "bold" }}>Activity</Text>
        <Text style={{ fontSize: 14, color: "#64748b" }}>Your order history</Text>
      </View>
      <FlatList
        data={orders}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: "white", marginHorizontal: 20, marginBottom: 10, padding: 16, borderRadius: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ fontSize: 28 }}>{countryFlag(item.countryCode)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: "600" }}>{item.planName}</Text>
                <Text style={{ fontSize: 12, color: "#64748b" }}>{new Date(item.createdAt).toLocaleDateString()}</Text>
              </View>
              <Text style={{ fontSize: 16, fontWeight: "bold" }}>{formatPrice(item.amountMinor, item.currency)}</Text>
            </View>
            <View style={{ marginTop: 8, alignSelf: "flex-start", backgroundColor: "#f1f5f9", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: "#64748b", textTransform: "capitalize" }}>{item.status.replace(/_/g, " ").toLowerCase()}</Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}
