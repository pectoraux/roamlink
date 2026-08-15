/**
 * Phase 7.4 — AI Intent Extraction
 *
 * Uses the z-ai-web-dev-sdk LLM to extract structured intent from natural
 * language connectivity requests. The LLM produces ONLY structured output
 * (a ParsedIntent JSON) — it does NOT rank offers. The deterministic
 * ranking engine (rankOffers) receives the structured intent and scores
 * it deterministically, unchanged.
 *
 * Flow:
 *   raw text → LLM extraction → ParsedIntent JSON → rankOffers() [deterministic]
 *
 * The deterministic parser (intent-parser.ts) is the fallback if the LLM
 * fails or is not configured.
 */

import ZAI from "z-ai-web-dev-sdk";
import { logger } from "@/lib/logger";
import { parseIntent, type ParsedIntent } from "./intent-parser";

// ---------------------------------------------------------------------------
// AI Intent Extraction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a connectivity intent parser. Extract structured intent from natural language connectivity requests.

Return ONLY a JSON object with this exact shape (no other text, no markdown):
{
  "capabilityType": "INTERNET" | "ROAMING" | "LOCAL_NETWORK" | "VPN_ACCESS" | null,
  "desiredSpec": {
    "downloadMbps": number | null,
    "uploadMbps": number | null,
    "dataLimitBytes": number | null,
    "validityDays": number | null,
    "allowedCountries": string[] | null
  },
  "location": {
    "country": "ISO 3166-1 alpha-2 code (e.g., GH, NG, KE)" | null,
    "region": string | null,
    "city": string | null
  },
  "maxPriceMinor": number | null,
  "confidence": number (0.0 to 1.0)
}

Rules:
- "INTERNET" = WiFi/broadband/home internet. "ROAMING" = eSIM/travel/mobile data.
- If the user mentions "travel", "abroad", "eSIM" → ROAMING. If "WiFi", "home", "office" → INTERNET.
- maxPriceMinor is in minor units (e.g., $20 = 2000). If user says "cheap" or "affordable", estimate $10-15.
- If a field is not mentioned, set it to null.
- Confidence reflects how clearly the intent was expressed (0.5+ if location + capability are clear).
- allowedCountries uses ISO codes: GH=Ghana, NG=Nigeria, KE=Kenya, TG=Togo, CI=Ivory Coast, SN=Senegal.
- dataLimitBytes: 1GB = 1000000000, 5GB = 5000000000.`;

/**
 * Extract structured intent from natural language using the LLM.
 *
 * The LLM produces ONLY structured JSON — it does not rank offers. The
 * deterministic ranking engine receives this output and scores it
 * deterministically.
 *
 * If the LLM fails or is not configured, falls back to the deterministic
 * keyword parser (intent-parser.ts).
 */
export async function extractIntentWithAI(rawText: string): Promise<ParsedIntent> {
  try {
    const zai = await ZAI.create();

    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: SYSTEM_PROMPT },
        { role: "user", content: rawText },
      ],
      thinking: { type: "disabled" },
    });

    const response = completion.choices[0]?.message?.content;
    if (!response) {
      logger.warn("ai_intent.empty_response", { rawText });
      return parseIntent(rawText); // fallback
    }

    // Parse the JSON response
    let parsed: Partial<ParsedIntent>;
    try {
      // Strip any markdown code fences if present
      const jsonStr = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      logger.warn("ai_intent.parse_failed", { rawText, response: response.substring(0, 200) });
      return parseIntent(rawText); // fallback
    }

    // Normalize the parsed intent into the ParsedIntent shape
    const result: ParsedIntent = {
      rawText,
      capabilityType: parsed.capabilityType ?? undefined,
      desiredSpec: parsed.desiredSpec ?? undefined,
      location: parsed.location ?? undefined,
      maxPriceMinor: parsed.maxPriceMinor ?? undefined,
      confidence: parsed.confidence ?? 0.5,
    };

    logger.info("ai_intent.extracted", {
      rawText,
      capabilityType: result.capabilityType,
      location: result.location,
      confidence: result.confidence,
    });

    return result;
  } catch (err) {
    logger.error("ai_intent.failed", {
      rawText,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback to deterministic parser
    return parseIntent(rawText);
  }
}

/**
 * Check if the AI intent extraction is available (the SDK is configured).
 */
export function isAIIntentAvailable(): boolean {
  return true; // The z-ai-web-dev-sdk is always available in this environment
}
