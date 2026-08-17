/**
 * Root layout — sets up auth provider, theme, routing, and intent sync lifecycle.
 *
 * Phase 9.5.1 (Gate B): The app lifecycle owns intent synchronization.
 *   - On mount: start intent sync
 *   - On foreground: flush intent outbox
 *   - On logout: stop intent sync
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, AppStateStatus } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { flushIntentOutbox } from "../lib/connectivity/intent-client";
import { clearCurrentConnectivityCache } from "../lib/connectivity/current-connectivity";

function IntentSyncLifecycle() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    // Flush on mount (app start / login)
    flushIntentOutbox().catch(() => {});

    // Flush on foreground (app returned from background)
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        flushIntentOutbox().catch(() => {});
        clearCurrentConnectivityCache();
      }
    });

    // Periodic flush every 60s
    const interval = setInterval(() => {
      flushIntentOutbox().catch(() => {});
    }, 60_000);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [user]);

  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <IntentSyncLifecycle />
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
        <Stack.Screen name="connectivity-settings" options={{ title: "Connectivity", headerShown: true }} />
      </Stack>
    </AuthProvider>
  );
}
