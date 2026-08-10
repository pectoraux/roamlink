/**
 * Mobile API client — wraps the shared RoamLinkClient with secure token storage.
 * Uses expo-secure-store for the session token (not AsyncStorage — Rule 35).
 */

import * as SecureStore from "expo-secure-store";
import { RoamLinkClient } from "@roamlink/shared";

// In production, this would be your deployed backend URL.
// For dev, use your local machine's IP (not localhost — the emulator is a separate VM).
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  "https://roamlink-chi.vercel.app"; // production backend

export const api = new RoamLinkClient(API_BASE_URL);

const SESSION_KEY = "roamlink_session";

/** Store the session token securely. */
export async function saveSession(token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

/** Retrieve the session token. */
export async function getSession(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_KEY);
}

/** Clear the session token. */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}
