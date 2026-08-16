/**
 * Phase 9.1 — Device Context
 *
 * Collects device-level context needed by the controller: platform, app
 * version, network transport, roaming, battery, power-saver, metered.
 *
 * Privacy-minimal by construction — no arbitrary device telemetry.
 */

import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Battery from "expo-battery";
import * as Network from "expo-network";
import type { EdgeDeviceContext, EdgeTransport } from "@roamlink/shared";

export async function getDeviceContext(): Promise<EdgeDeviceContext> {
  const networkState = await Network.getNetworkStateAsync();
  const batteryState = await Battery.getBatteryStateAsync();
  const batteryLevel = await Battery.getBatteryLevelAsync();
  const isLowPower = await Battery.isLowPowerModeEnabledAsync().catch(() => false);

  const transport: EdgeTransport = mapTransport(networkState.type);

  return {
    platform: Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "unknown",
    appVersion: Constants.expoConfig?.version ?? "unknown",
    networkTransport: transport,
    roaming: false, // expo-network doesn't expose roaming reliably; default false
    batteryState: mapBatteryState(batteryState, batteryLevel),
    powerSaver: isLowPower,
    metered: false, // expo-network doesn't expose metered; default false
  };
}

function mapTransport(type: Network.NetworkStateType): EdgeTransport {
  if (type === Network.NetworkStateType.WIFI) return "WIFI";
  if (type === Network.NetworkStateType.CELLULAR) return "CELLULAR";
  if (type === Network.NetworkStateType.ETHERNET) return "ETHERNET";
  return "UNKNOWN";
}

function mapBatteryState(
  state: Battery.BatteryState,
  level: number,
): EdgeDeviceContext["batteryState"] {
  if (state === Battery.BatteryState.CHARGING) return "charging";
  if (state === Battery.BatteryState.FULL) return "full";
  if (state === Battery.BatteryState.UNPLUGGED) {
    return level < 0.15 ? "low" : "unplugged";
  }
  return "unknown";
}

/**
 * Get or create a stable device identifier. Stored in AsyncStorage (not
 * SecureStore — it's not secret, just stable).
 */
import * as AsyncStorage from "@react-native-async-storage/async-storage";

const DEVICE_ID_KEY = "roamlink_device_id";

export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    // Generate a stable ID (not random per session)
    id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export async function getSequence(): Promise<number> {
  const seqStr = await AsyncStorage.getItem("roamlink_obs_sequence");
  const seq = seqStr ? parseInt(seqStr, 10) : 0;
  const next = seq + 1;
  await AsyncStorage.setItem("roamlink_obs_sequence", String(next));
  return next;
}
