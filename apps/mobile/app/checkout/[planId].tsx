/**
 * Checkout — simple pay screen. Uses the same backend payment architecture.
 * For mock provider: creates order → initiates payment → confirms → provisions.
 */

import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ShieldCheck } from "lucide-react-native";
import type { PublicPlan } from "@roamlink/shared";
import { formatPrice, formatDataSize, countryFlag } from "@roamlink/shared";
import { api, getSession } from "../../lib/api";

export default function CheckoutScreen() {
  const { planId } = useLocalSearchParams<{ planId: string }>();
  const router = useRouter();
  const [plan, setPlan] = useState<PublicPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [planLoaded, setPlanLoaded] = useState(false);

  // Load plan
  if (!planLoaded) {
    setPlanLoaded(true);
    api.getPlan(planId).then((d) => setPlan(d.plan)).catch(() => {});
  }

  async function handlePay() {
    if (!plan) return;
    setLoading(true);
    try {
      const token = await getSession();
      if (!token) { router.push("/login"); return; }

      // 1. Create order
      const orderRes = await api.createOrder(token, plan.id, `checkout_${plan.id}_${Date.now()}`);
      const orderId = orderRes.order.id;

      // 2. Initiate payment
      const payRes = await api.initiatePayment(token, orderId, `payment_${orderId}`);

      // 3. Confirm + provision (server-side verified)
      const confirmRes = await api.confirmPayment(token, orderId, payRes.paymentReference, `confirm_${orderId}`);

      if (confirmRes.status === "COMPLETED" && confirmRes.esimId) {
        Alert.alert("Success 🎉", "Your eSIM is ready!");
        router.replace(`/install/${confirmRes.esimId}`);
      } else if (confirmRes.status === "PROVISIONING_FAILED") {
        Alert.alert("Processing", "Payment received — we're activating your eSIM.");
        router.replace(`/esim/${confirmRes.esimId || orderId}`);
      } else {
        Alert.alert("Processing", "Payment is being verified.");
      }
    } catch (e: any) {
      Alert.alert("Checkout failed", e.message || "Please try again");
    } finally {
      setLoading(false);
    }
  }

  if (!plan) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <Text style={{ fontSize: 40 }}>{countryFlag(plan.countryCode)}</Text>
          <View>
            <Text style={{ fontSize: 20, fontWeight: "bold" }}>{plan.country}</Text>
            <Text style={{ fontSize: 14, color: "#64748b" }}>{formatDataSize(plan.dataAmountMB)} · {plan.validityDays} days</Text>
          </View>
        </View>

        <View style={{ backgroundColor: "white", borderRadius: 16, padding: 18 }}>
          <Row label="Data" value={formatDataSize(plan.dataAmountMB)} />
          <Row label="Validity" value={`${plan.validityDays} days`} />
          <Row label="Network" value={plan.speed || "4G/5G"} />
          <Row label="Subtotal" value={formatPrice(plan.priceMinor, plan.currency)} />
          <Row label="Taxes & fees" value="Included" />
          <View style={{ height: 1, backgroundColor: "#e2e8f0", marginVertical: 10 }} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 16, fontWeight: "600" }}>Total</Text>
            <Text style={{ fontSize: 24, fontWeight: "bold" }}>{formatPrice(plan.priceMinor, plan.currency)}</Text>
          </View>
        </View>

        <View style={{ backgroundColor: "#f0fdfa", borderRadius: 12, padding: 14, marginTop: 16 }}>
          <Text style={{ fontSize: 13, color: "#0d9488", fontWeight: "500" }}>Development mode — mock payment. No real card is charged.</Text>
        </View>
      </View>

      <View style={{ flex: 1 }} />
      <View style={{ padding: 20, backgroundColor: "white", borderTopWidth: 1, borderTopColor: "#e2e8f0" }}>
        <Pressable onPress={handlePay} disabled={loading} style={{ backgroundColor: "#0d9488", paddingVertical: 16, borderRadius: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}>
          {loading ? <ActivityIndicator color="white" /> : <Text style={{ color: "white", fontSize: 18, fontWeight: "600" }}>Pay {formatPrice(plan.priceMinor, plan.currency)}</Text>}
        </Pressable>
        <Text style={{ textAlign: "center", fontSize: 12, color: "#64748b", marginTop: 10 }}>Secured · Server-verified payment</Text>
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}>
      <Text style={{ fontSize: 14, color: "#64748b" }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: "500" }}>{value}</Text>
    </View>
  );
}
