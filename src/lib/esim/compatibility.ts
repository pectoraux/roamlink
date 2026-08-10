/**
 * Device compatibility service.
 *
 * Distinguishes between:
 *  - eSIM hardware compatibility (the device has an eSIM chip)
 *  - native installation support (the OS supports programmatic eSIM installation)
 *
 * These are NOT the same thing. A device may have an eSIM chip but not support
 * native installation APIs (e.g. older Android), requiring QR/manual fallback.
 *
 * For MVP this uses a static dataset. In production this would be backed by a
 * maintained device database (e.g. GSMA database).
 */

export type CompatibilityResult = {
  device: string;
  esimCompatible: boolean;
  nativeInstallationSupported: boolean;
  platform: "ios" | "android" | "unknown";
  notes?: string;
};

// Static dataset of common eSIM-compatible devices. Extend as needed.
const DEVICE_DATASET: Record<string, CompatibilityResult> = {
  // iPhone (iOS 17+ supports native eSIM installation via CellularPlan)
  "iphone xs": { device: "iPhone XS", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone xs max": { device: "iPhone XS Max", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone xr": { device: "iPhone XR", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 11": { device: "iPhone 11", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 11 pro": { device: "iPhone 11 Pro", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 12": { device: "iPhone 12", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 12 mini": { device: "iPhone 12 mini", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 13": { device: "iPhone 13", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 14": { device: "iPhone 14", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 15": { device: "iPhone 15", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone 16": { device: "iPhone 16", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone se (2nd gen)": { device: "iPhone SE (2nd gen)", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },
  "iphone se (3rd gen)": { device: "iPhone SE (3rd gen)", esimCompatible: true, nativeInstallationSupported: true, platform: "ios" },

  // Google Pixel (Android 13+ supports native eSIM via EuiccManager)
  "pixel 3": { device: "Pixel 3", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "pixel 4": { device: "Pixel 4", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "pixel 5": { device: "Pixel 5", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "pixel 6": { device: "Pixel 6", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "pixel 7": { device: "Pixel 7", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "pixel 8": { device: "Pixel 8", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "pixel 9": { device: "Pixel 9", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },

  // Samsung Galaxy (varies by region — US models typically support eSIM)
  "galaxy s20": { device: "Samsung Galaxy S20", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "galaxy s21": { device: "Samsung Galaxy S21", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "galaxy s22": { device: "Samsung Galaxy S22", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "galaxy s23": { device: "Samsung Galaxy S23", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "galaxy s24": { device: "Samsung Galaxy S24", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "galaxy note 20": { device: "Samsung Galaxy Note 20", esimCompatible: true, nativeInstallationSupported: false, platform: "android", notes: "eSIM supported but native installation may require QR code" },
  "galaxy z fold 3": { device: "Samsung Galaxy Z Fold 3", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
  "galaxy z flip 3": { device: "Samsung Galaxy Z Flip 3", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },

  // Motorola
  "motorola edge": { device: "Motorola Edge", esimCompatible: true, nativeInstallationSupported: false, platform: "android", notes: "eSIM supported via QR code only" },
  "motorola razr": { device: "Motorola Razr", esimCompatible: true, nativeInstallationSupported: true, platform: "android" },
};

/** Check device compatibility by name. Returns null if device not found. */
export function checkDeviceCompatibility(query: string): CompatibilityResult | null {
  const normalized = query.trim().toLowerCase();
  // Direct match
  if (DEVICE_DATASET[normalized]) return DEVICE_DATASET[normalized];
  // Partial match
  const match = Object.entries(DEVICE_DATASET).find(([key]) => key.includes(normalized) || normalized.includes(key));
  return match ? match[1] : null;
}

/** Get platform-level guidance. */
export function platformGuidance(platform: "ios" | "android"): {
  esimCompatibleByDefault: boolean;
  nativeInstallationSupported: boolean;
  instructions: string;
} {
  if (platform === "ios") {
    return {
      esimCompatibleByDefault: true,
      nativeInstallationSupported: true,
      instructions: "iPhone XS and later support eSIM. Install via Settings → Cellular → Add eSIM.",
    };
  }
  return {
    esimCompatibleByDefault: false,
    nativeInstallationSupported: false,
    instructions: "Android eSIM support varies by manufacturer and model. Check your device settings for 'SIMs' or 'eSIM' options. Many Android devices require QR code installation.",
  };
}
