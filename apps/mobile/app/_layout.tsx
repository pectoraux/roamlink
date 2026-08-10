/**
 * Root layout — sets up auth provider, theme, and routing.
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../lib/auth";

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" options={{ presentation: "modal" }} />
        <Stack.Screen name="plan/[id]" options={{ title: "Plan", headerShown: true }} />
        <Stack.Screen name="checkout/[planId]" options={{ title: "Checkout", headerShown: true }} />
        <Stack.Screen name="esim/[id]" options={{ title: "eSIM", headerShown: true }} />
        <Stack.Screen name="install/[esimId]" options={{ title: "Install", headerShown: true }} />
        <Stack.Screen name="topup/[esimId]" options={{ title: "Top Up", headerShown: true }} />
        <Stack.Screen name="number-search/[code]" options={{ title: "Numbers", headerShown: true }} />
        <Stack.Screen name="number/[id]" options={{ title: "Number", headerShown: true }} />
      </Stack>
    </AuthProvider>
  );
}
