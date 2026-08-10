/**
 * Explore — destination-first browsing, grouped by region.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, SectionList, TextInput, RefreshControl } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Search, ChevronRight } from "lucide-react-native";
import type { PublicPlan } from "@roamlink/shared";
import { formatPrice, formatDataSize, countryFlag } from "@roamlink/shared";
import { api } from "../../../lib/api";

type CountryGroup = { country: string; countryCode: string; region: string; minPrice: number; planCount: number };

export default function ExploreScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string; country?: string }>();
  const [search, setSearch] = useState(params.q || "");
  const [countries, setCountries] = useState<CountryGroup[]>([]);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const res = await api.getPlans(params.country ? { country: params.country } : undefined);
      setPlans(res.plans);
      // Group by country
      const byCountry = new Map<string, CountryGroup>();
      res.plans.forEach((p) => {
        const existing = byCountry.get(p.countryCode);
        if (existing) {
          existing.planCount++;
          existing.minPrice = Math.min(existing.minPrice, p.priceMinor);
        } else {
          byCountry.set(p.countryCode, { country: p.country, countryCode: p.countryCode, region: p.region, minPrice: p.priceMinor, planCount: 1 });
        }
      });
      setCountries(Array.from(byCountry.values()));
    } catch { /* */ } finally { setLoading(false); setRefreshing(false); }
  }, [params.country]);

  useEffect(() => { loadData(); }, [loadData]);

  // If a specific country is selected, show plans
  if (params.country) {
    const filtered = search ? plans.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) : plans;
    return (
      <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
        <View style={{ padding: 20, paddingBottom: 10 }}>
          <Text style={{ fontSize: 24, fontWeight: "bold" }}>{plans[0] ? `${countryFlag(plans[0].countryCode)} ${plans[0].country} eSIM` : "Plans"}</Text>
          <Text style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>{filtered.length} plans available</Text>
        </View>
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/plan/${item.id}`)} style={{ backgroundColor: "white", marginHorizontal: 20, marginBottom: 12, padding: 18, borderRadius: 16 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                <View>
                  <Text style={{ fontSize: 22, fontWeight: "bold", color: "#0f172a" }}>{formatDataSize(item.dataAmountMB)}</Text>
                  <Text style={{ fontSize: 14, color: "#64748b" }}>{item.validityDays} days · {item.speed}</Text>
                </View>
                <Text style={{ fontSize: 20, fontWeight: "bold", color: "#0d9488" }}>{formatPrice(item.priceMinor, item.currency)}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 10 }}>
                {item.hotspot && <Text style={{ fontSize: 11, color: "#64748b", backgroundColor: "#f1f5f9", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>Hotspot</Text>}
                {item.topUpSupported && <Text style={{ fontSize: 11, color: "#64748b", backgroundColor: "#f1f5f9", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>Top-up</Text>}
              </View>
            </Pressable>
          )}
        />
      </View>
    );
  }

  // Otherwise show destinations grouped by region
  const sections = Array.from(new Set(countries.map((c) => c.region))).map((region) => ({
    title: region,
    data: countries.filter((c) => c.region === region),
  }));

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20, paddingBottom: 10 }}>
        <Text style={{ fontSize: 24, fontWeight: "bold" }}>Explore destinations</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.countryCode}
        renderSectionHeader={({ section: { title } }) => (
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#64748b", textTransform: "uppercase", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, backgroundColor: "#f8faf9" }}>{title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push(`/explore?country=${item.countryCode}`)} style={{ flexDirection: "row", alignItems: "center", backgroundColor: "white", marginHorizontal: 20, marginBottom: 8, padding: 16, borderRadius: 14, gap: 12 }}>
            <Text style={{ fontSize: 28 }}>{countryFlag(item.countryCode)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: "600" }}>{item.country}</Text>
              <Text style={{ fontSize: 13, color: "#64748b" }}>{item.planCount} plans · from {formatPrice(item.minPrice)}</Text>
            </View>
            <ChevronRight size={20} color="#cbd5e1" />
          </Pressable>
        )}
      />
    </View>
  );
}
