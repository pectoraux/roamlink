/**
 * eSIM provider factory — selects the concrete provider from ESIM_PROVIDER.
 *
 * This is the ONLY place in the app that decides which provider to use. Everything
 * else depends on the ESIMProvider interface.
 */

import type { ESIMProvider } from "./provider";
import { MockESIMProvider, mockESIMProvider } from "./mock-provider";
import { RealESIMProvider } from "./real-provider";

let cached: ESIMProvider | null = null;

export function getESIMProvider(): ESIMProvider {
  if (cached) return cached;
  const key = (process.env.ESIM_PROVIDER || "mock").toLowerCase();
  switch (key) {
    case "mock":
      cached = mockESIMProvider;
      break;
    default:
      // Any non-mock key selects the real provider boundary.
      cached = new RealESIMProvider();
      break;
  }
  return cached;
}

export type { ESIMProvider } from "./provider";
export { MockESIMProvider, mockESIMProvider } from "./mock-provider";
export { RealESIMProvider } from "./real-provider";
