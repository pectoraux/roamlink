/**
 * Profile — account info + sign out.
 */

import { View, Text, Pressable, Alert } from "react-native";
import { LogOut, Mail, Shield, Info } from "lucide-react-native";
import { useAuth } from "../../../lib/auth";

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  function handleSignOut() {
    Alert.alert("Sign out", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => signOut() },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ padding: 20, alignItems: "center" }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: "#0d9488", justifyContent: "center", alignItems: "center" }}>
          <Text style={{ fontSize: 28, fontWeight: "bold", color: "white" }}>{user?.email?.[0]?.toUpperCase() ?? "U"}</Text>
        </View>
        <Text style={{ fontSize: 20, fontWeight: "bold", marginTop: 12 }}>{user?.name || "Account"}</Text>
        <Text style={{ fontSize: 14, color: "#64748b" }}>{user?.email}</Text>
        {user?.isDemo && <Text style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>Demo account</Text>}
      </View>

      <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
        <View style={{ backgroundColor: "white", borderRadius: 14, overflow: "hidden" }}>
          <Row icon={Mail} label="Email" value={user?.email} />
          <Row icon={Shield} label="Role" value={user?.role} last />
        </View>
      </View>

      <View style={{ flex: 1 }} />
      <View style={{ padding: 20 }}>
        <Pressable onPress={handleSignOut} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#fee2e2", paddingVertical: 14, borderRadius: 14 }}>
          <LogOut size={18} color="#ef4444" />
          <Text style={{ color: "#ef4444", fontSize: 16, fontWeight: "600" }}>Sign out</Text>
        </Pressable>
      </View>
      <View style={{ alignItems: "center", paddingBottom: 20 }}>
        <Text style={{ fontSize: 12, color: "#94a3b8" }}>RoamLink v0.1.0</Text>
      </View>
    </View>
  );
}

function Row({ icon: Icon, label, value, last }: { icon: any; label: string; value?: string; last?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", padding: 16, borderBottomWidth: last ? 0 : 1, borderBottomColor: "#f1f5f9", gap: 12 }}>
      <Icon size={18} color="#64748b" />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, color: "#94a3b8" }}>{label}</Text>
        <Text style={{ fontSize: 15, fontWeight: "500" }}>{value || "—"}</Text>
      </View>
    </View>
  );
}
