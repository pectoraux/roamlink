/**
 * Login screen — email/password with demo quick-login.
 */

import { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../lib/auth";

export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickLoading, setQuickLoading] = useState<string | null>(null);

  async function doLogin(em: string, pw: string) {
    try {
      await signIn(em, pw);
      router.replace("/");
    } catch (e) {
      throw e;
    }
  }

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      await doLogin(email, password);
    } catch (e: any) {
      setError(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function quickLogin(em: string, pw: string, label: string) {
    setQuickLoading(label);
    setError(null);
    try {
      await doLogin(em, pw);
    } catch (e: any) {
      setError(e.message || "Login failed");
    } finally {
      setQuickLoading(null);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, backgroundColor: "#f8faf9" }}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
        <View style={{ alignItems: "center", marginBottom: 32 }}>
          <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: "#0d9488", justifyContent: "center", alignItems: "center" }}>
            <Text style={{ fontSize: 28 }}>📡</Text>
          </View>
          <Text style={{ fontSize: 24, fontWeight: "bold", marginTop: 12 }}>RoamLink</Text>
          <Text style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>Sign in to manage your eSIMs</Text>
        </View>

        <TextInput
          style={inputStyle}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <TextInput
          style={inputStyle}
          placeholder="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        {error && <Text style={{ color: "#ef4444", fontSize: 14, textAlign: "center", marginBottom: 12 }}>{error}</Text>}

        <Pressable onPress={handleSubmit} disabled={loading} style={{ backgroundColor: "#0d9488", paddingVertical: 14, borderRadius: 14, alignItems: "center" }}>
          {loading ? <ActivityIndicator color="white" /> : <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>Sign in</Text>
        </Pressable>

        <View style={{ marginTop: 24, padding: 16, backgroundColor: "#f0fdfa", borderRadius: 14, borderWidth: 1, borderColor: "#0d9488", borderStyle: "dashed" }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#0d9488" }}>⚡ Quick demo login</Text>
          <Pressable
            onPress={() => quickLogin("demo@esim.local", "demo12345", "customer")}
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10, padding: 10, backgroundColor: "white", borderRadius: 10 }}
          >
            <Text style={{ fontSize: 14 }}>Demo Customer</Text>
            {quickLoading === "customer" ? <ActivityIndicator size="small" color="#0d9488" /> : <Text style={{ color: "#0d9488", fontSize: 13, fontWeight: "600" }}>Sign in →</Text>}
          </Pressable>
          <Pressable
            onPress={() => quickLogin("admin@esim.local", "admin12345", "admin")}
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: 10, backgroundColor: "white", borderRadius: 10 }}
          >
            <Text style={{ fontSize: 14 }}>Demo Admin</Text>
            {quickLoading === "admin" ? <ActivityIndicator size="small" color="#0d9488" /> : <Text style={{ color: "#0d9488", fontSize: 13, fontWeight: "600" }}>Sign in →</Text>}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const inputStyle = {
  backgroundColor: "white",
  borderWidth: 1,
  borderColor: "#e2e8f0",
  borderRadius: 14,
  paddingHorizontal: 16,
  paddingVertical: 14,
  fontSize: 16,
  marginBottom: 12,
} as const;
