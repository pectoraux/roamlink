/**
 * Number detail — shows number info, messages, calls, send SMS.
 */

import { useState, useEffect } from "react";
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, MessageSquare, Phone, Send, Trash2 } from "lucide-react-native";
import type { VirtualNumber, Message, Call } from "@roamlink/shared";
import { formatPrice, countryFlag, formatDate } from "@roamlink/shared";
import { api, getSession } from "../../lib/api";

export default function NumberDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [vn, setVn] = useState<(VirtualNumber & { messages?: Message[]; calls?: Call[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"messages" | "calls">("messages");
  const [sendTo, setSendTo] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await getSession();
      if (!token) { router.push("/login"); return; }
      try {
        const res = await api.getNumber(token, id);
        setVn(res.number);
      } catch { /* */ } finally { setLoading(false); }
    })();
  }, [id, router]);

  async function sendSMS() {
    if (!sendTo || !sendBody) return;
    setSending(true);
    try {
      const token = await getSession();
      if (!token) return;
      await api.sendSMS(token, id, sendTo, sendBody);
      Alert.alert("Sent!", "Message sent.");
      setSendTo("");
      setSendBody("");
      const res = await api.getNumber(token, id);
      setVn(res.number);
    } catch (e: any) {
      Alert.alert("Failed", e.message || "Could not send SMS");
    } finally {
      setSending(false);
    }
  }

  async function release() {
    Alert.alert("Release number?", "This will release your number back to the provider.", [
      { text: "Cancel", style: "cancel" },
      { text: "Release", style: "destructive", onPress: async () => {
        const token = await getSession();
        if (!token) return;
        await api.releaseNumber(token, id);
        router.back();
      }},
    ]);
  }

  if (loading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator size="large" color="#0d9488" /></View>;
  if (!vn) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>Number not found</Text></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20 }}>
        <Pressable onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 16 }}>
          <ArrowLeft size={18} color="#64748b" />
          <Text style={{ color: "#64748b" }}>Back</Text>
        </Pressable>

        {/* Number header */}
        <View style={{ alignItems: "center" }}>
          <Text style={{ fontSize: 48 }}>{countryFlag(vn.countryCode)}</Text>
          <Text style={{ fontSize: 24, fontWeight: "bold", fontFamily: "monospace", marginTop: 8 }}>{vn.e164}</Text>
          <Text style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>{vn.country} · {vn.region ?? "Local"}</Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            {vn.smsEnabled && <View style={{ backgroundColor: "#f1f5f9", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}><Text style={{ fontSize: 11 }}>💬 SMS</Text></View>}
            {vn.voiceEnabled && <View style={{ backgroundColor: "#f1f5f9", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}><Text style={{ fontSize: 11 }}>📞 Voice</Text></View>}
          </View>
          <Text style={{ fontSize: 13, color: "#94a3b8", marginTop: 8 }}>{formatPrice(vn.sellingPrice, vn.currency)}/mo · Renews {vn.expiresAt ? formatDate(vn.expiresAt) : "—"}</Text>
        </View>

        {/* Tabs */}
        <View style={{ flexDirection: "row", marginTop: 24, backgroundColor: "#f1f5f9", borderRadius: 10, padding: 3 }}>
          <Pressable onPress={() => setTab("messages")} style={{ flex: 1, paddingVertical: 8, alignItems: "center", backgroundColor: tab === "messages" ? "white" : "transparent", borderRadius: 8 }}>
            <Text style={{ fontWeight: "600", color: tab === "messages" ? "#0d9488" : "#64748b" }}>Messages</Text>
          </Pressable>
          <Pressable onPress={() => setTab("calls")} style={{ flex: 1, paddingVertical: 8, alignItems: "center", backgroundColor: tab === "calls" ? "white" : "transparent", borderRadius: 8 }}>
            <Text style={{ fontWeight: "600", color: tab === "calls" ? "#0d9488" : "#64748b" }}>Calls</Text>
          </Pressable>
        </View>

        {/* Messages tab */}
        {tab === "messages" && (
          <View style={{ marginTop: 16 }}>
            {vn.smsEnabled && (
              <View style={{ backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", marginBottom: 10 }}>Send SMS</Text>
                <TextInput style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 8 }} placeholder="To: +233..." value={sendTo} onChangeText={setSendTo} />
                <TextInput style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 8 }} placeholder="Message..." value={sendBody} onChangeText={setSendBody} multiline />
                <Pressable onPress={sendSMS} disabled={sending} style={{ backgroundColor: "#0d9488", paddingVertical: 10, borderRadius: 10, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6 }}>
                  {sending ? <ActivityIndicator color="white" size="small" /> : <><Send size={16} color="white" /><Text style={{ color: "white", fontWeight: "600" }}>Send</Text></>}
                </Pressable>
              </View>
            )}
            {vn.messages?.length === 0 ? (
              <Text style={{ textAlign: "center", color: "#94a3b8", paddingVertical: 20 }}>No messages yet</Text>
            ) : (
              vn.messages?.map((m) => (
                <View key={m.id} style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 8 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 11, color: "#94a3b8" }}>{m.direction === "inbound" ? `From: ${m.fromNumber}` : `To: ${m.toNumber}`}</Text>
                    <Text style={{ fontSize: 11, color: "#94a3b8" }}>{formatDate(m.createdAt)}</Text>
                  </View>
                  <Text style={{ fontSize: 14, marginTop: 4 }}>{m.body}</Text>
                </View>
              ))
            )}
          </View>
        )}

        {/* Calls tab */}
        {tab === "calls" && (
          <View style={{ marginTop: 16 }}>
            {vn.calls?.length === 0 ? (
              <Text style={{ textAlign: "center", color: "#94a3b8", paddingVertical: 20 }}>No calls yet</Text>
            ) : (
              vn.calls?.map((c) => (
                <View key={c.id} style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 8 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 14, fontWeight: "500" }}>{c.direction === "inbound" ? `From: ${c.fromNumber}` : `To: ${c.toNumber}`}</Text>
                    <Text style={{ fontSize: 11, color: "#94a3b8" }}>{formatDate(c.createdAt)}</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                    <Text style={{ fontSize: 12, color: "#64748b" }}>{c.status}</Text>
                    <Text style={{ fontSize: 12, color: "#64748b" }}>{Math.floor(c.durationSeconds / 60)}m {c.durationSeconds % 60}s</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* Release button */}
        <Pressable onPress={release} style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingVertical: 14, marginTop: 24, marginBottom: 40 }}>
          <Trash2 size={16} color="#ef4444" />
          <Text style={{ color: "#ef4444", fontWeight: "600" }}>Release number</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
