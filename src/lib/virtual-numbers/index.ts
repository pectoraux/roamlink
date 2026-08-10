/**
 * Virtual number provider factory — selects the concrete provider from VN_PROVIDER.
 *
 * Supported: mock | (real providers when implemented)
 */

import type { VirtualNumberProvider } from "./provider";
import { MockVirtualNumberProvider, mockVNProvider } from "./mock-provider";

let cached: VirtualNumberProvider | null = null;

export function getVNProvider(): VirtualNumberProvider {
  if (cached) return cached;
  const key = (process.env.VN_PROVIDER || "mock").toLowerCase();
  switch (key) {
    case "mock":
      cached = mockVNProvider;
      break;
    default:
      // Real providers (Telnyx, Twilio, Vonage) would be implemented as
      // separate adapters selected here. We do not fabricate them.
      throw new Error(
        `Unknown VN_PROVIDER "${key}". Supported: mock. Implement a real adapter when provider docs are available.`,
      );
  }
  return cached;
}

export type { VirtualNumberProvider } from "./provider";
export { MockVirtualNumberProvider, mockVNProvider } from "./mock-provider";
