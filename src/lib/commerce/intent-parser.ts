/**
 * Phase 6.3 — Connectivity Intelligence: Intent Parser
 *
 * A DETERMINISTIC parser that converts natural language connectivity
 * requests into structured intent. No AI — pure keyword + pattern matching.
 *
 * Examples:
 *   "I need internet in Accra today"
 *     → { capabilityType: "INTERNET", location: { city: "Accra" }, validityDays: 1 }
 *
 *   "I need cheap internet while travelling"
 *     → { capabilityType: "ROAMING", maxPriceMinor: 1000 }
 *
 *   "I need connectivity for 50 employees"
 *     → { capabilityType: "INTERNET", employeeCount: 50 }
 *
 * The parser extracts:
 *   - Location (cities, countries, regions)
 *   - Capability type (internet, roaming, wifi, esim)
 *   - Budget (cheap, under $X)
 *   - Validity (today, weekly, monthly, 30 days)
 *   - Speed (fast, 50Mbps, 100Mbps)
 *   - Scale (employees, devices)
 *
 * The output is a structured IntentInput that the ranking engine can score.
 */

import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedIntent = {
  capabilityType?: string;
  desiredSpec?: {
    downloadMbps?: number;
    uploadMbps?: number;
    dataLimitBytes?: number;
    validityDays?: number;
    allowedCountries?: string[];
  };
  location?: {
    country?: string;
    region?: string;
    city?: string;
  };
  maxPriceMinor?: number;
  rawText: string;
  confidence: number; // 0.0–1.0, how confident the parser is
};

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

// Known locations (West Africa focused — the MVP market)
const KNOWN_CITIES: Record<string, { country: string; region?: string }> = {
  "accra": { country: "GH", region: "Greater Accra" },
  "kumasi": { country: "GH", region: "Ashanti" },
  "takoradi": { country: "GH", region: "Western" },
  "tamale": { country: "GH", region: "Northern" },
  "lagos": { country: "NG", region: "Lagos State" },
  "abuja": { country: "NG", region: "FCT" },
  "nairobi": { country: "KE", region: "Nairobi County" },
  "mombasa": { country: "KE", region: "Coast" },
};

const KNOWN_COUNTRIES: Record<string, string> = {
  "ghana": "GH",
  "nigeria": "NG",
  "kenya": "KE",
  "togo": "TG",
  "ivory coast": "CI",
  "senegal": "SN",
};

// Capability keywords
const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  INTERNET: ["internet", "wifi", "wi-fi", "broadband", "connection"],
  ROAMING: ["roaming", "travel", "travelling", "traveling", "abroad", "esim", "e-sim"],
  LOCAL_NETWORK: ["lan", "local network", "intranet"],
  VPN_ACCESS: ["vpn", "secure", "remote"],
};

// Budget keywords
const BUDGET_KEYWORDS: Record<string, number> = {
  "cheap": 1000, // $10
  "affordable": 1500, // $15
  "budget": 1000,
  "low cost": 1000,
  "premium": 5000, // $50
  "unlimited": 10000, // $100
};

// Validity keywords
const VALIDITY_KEYWORDS: Record<string, number> = {
  "today": 1,
  "day": 1,
  "daily": 1,
  "weekly": 7,
  "week": 7,
  "monthly": 30,
  "month": 30,
  "yearly": 365,
  "year": 365,
};

// Speed keywords
const SPEED_KEYWORDS: Record<string, number> = {
  "fast": 100,
  "high speed": 100,
  "high-speed": 100,
  "slow": 10,
  "basic": 10,
};

// ---------------------------------------------------------------------------
// Parse Function
// ---------------------------------------------------------------------------

/**
 * Parse a natural language connectivity request into structured intent.
 *
 * This is a DETERMINISTIC function — no AI, no randomness. The same input
 * always produces the same output. It uses keyword + pattern matching to
 * extract location, capability, budget, validity, and speed from the text.
 *
 * The confidence score reflects how many dimensions were successfully
 * extracted. A low confidence means the parser couldn't identify key
 * details — the caller may want to ask for clarification.
 */
export function parseIntent(rawText: string): ParsedIntent {
  const text = rawText.toLowerCase().trim();
  const result: ParsedIntent = {
    rawText,
    confidence: 0,
  };

  let extractedDimensions = 0;

  // --- Location ---
  for (const [city, info] of Object.entries(KNOWN_CITIES)) {
    if (text.includes(city)) {
      result.location = {
        city: city.charAt(0).toUpperCase() + city.slice(1),
        country: info.country,
        region: info.region,
      };
      extractedDimensions++;
      break;
    }
  }

  if (!result.location) {
    for (const [country, code] of Object.entries(KNOWN_COUNTRIES)) {
      if (text.includes(country)) {
        result.location = { country: code };
        extractedDimensions++;
        break;
      }
    }
  }

  // --- Capability Type ---
  for (const [capability, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      result.capabilityType = capability;
      extractedDimensions++;
      break;
    }
  }

  // --- Budget ---
  for (const [keyword, maxPrice] of Object.entries(BUDGET_KEYWORDS)) {
    if (text.includes(keyword)) {
      result.maxPriceMinor = maxPrice;
      extractedDimensions++;
      break;
    }
  }

  // Also check for explicit price: "under $20", "below 50 cedis"
  const priceMatch = text.match(/(?:under|below|less than|max|up to)\s*\$?(\d+)/);
  if (priceMatch) {
    result.maxPriceMinor = parseInt(priceMatch[1], 10) * 100; // convert to minor
    extractedDimensions++;
  }

  // --- Validity ---
  if (!result.desiredSpec) result.desiredSpec = {};
  for (const [keyword, days] of Object.entries(VALIDITY_KEYWORDS)) {
    if (text.includes(keyword)) {
      result.desiredSpec.validityDays = days;
      extractedDimensions++;
      break;
    }
  }

  // Check for explicit days: "30 days", "7 days"
  const daysMatch = text.match(/(\d+)\s*days?/);
  if (daysMatch) {
    result.desiredSpec.validityDays = parseInt(daysMatch[1], 10);
    extractedDimensions++;
  }

  // --- Speed ---
  for (const [keyword, mbps] of Object.entries(SPEED_KEYWORDS)) {
    if (text.includes(keyword)) {
      result.desiredSpec.downloadMbps = mbps;
      extractedDimensions++;
      break;
    }
  }

  // Check for explicit Mbps: "50Mbps", "50 mbps", "100Mbps"
  const speedMatch = text.match(/(\d+)\s*(?:mbps|mb\/s)/);
  if (speedMatch) {
    result.desiredSpec.downloadMbps = parseInt(speedMatch[1], 10);
    extractedDimensions++;
  }

  // --- Data limit ---
  const dataMatch = text.match(/(\d+)\s*(gb|gig)/);
  if (dataMatch) {
    result.desiredSpec.dataLimitBytes = parseInt(dataMatch[1], 10) * 1_000_000_000;
    extractedDimensions++;
  }

  // --- Confidence ---
  // Confidence = how many dimensions were extracted, capped at 1.0
  result.confidence = Math.min(1.0, extractedDimensions / 4);

  logger.info("intent.parsed", {
    rawText,
    extractedDimensions,
    confidence: result.confidence,
    capabilityType: result.capabilityType,
    location: result.location,
  });

  return result;
}

/**
 * Generate a human-readable summary of the parsed intent.
 * Used for the UI to confirm the parser understood the request.
 */
export function summarizeIntent(intent: ParsedIntent): string {
  const parts: string[] = [];

  if (intent.capabilityType) {
    parts.push(intent.capabilityType === "INTERNET" ? "Internet" :
               intent.capabilityType === "ROAMING" ? "Roaming connectivity" :
               intent.capabilityType);
  }

  if (intent.location) {
    const locParts: string[] = [];
    if (intent.location.city) locParts.push(intent.location.city);
    if (intent.location.country) locParts.push(intent.location.country);
    parts.push(`in ${locParts.join(", ")}`);
  }

  if (intent.desiredSpec?.downloadMbps) {
    parts.push(`${intent.desiredSpec.downloadMbps}Mbps`);
  }

  if (intent.desiredSpec?.dataLimitBytes) {
    parts.push(`${intent.desiredSpec.dataLimitBytes / 1_000_000_000}GB data`);
  }

  if (intent.desiredSpec?.validityDays) {
    parts.push(`for ${intent.desiredSpec.validityDays} day${intent.desiredSpec.validityDays > 1 ? "s" : ""}`);
  }

  if (intent.maxPriceMinor) {
    parts.push(`under $${intent.maxPriceMinor / 100}`);
  }

  return parts.join(" ") || "General connectivity";
}
