/**
 * Phase 6.2/6.3 — Intent API
 * POST /api/commerce/intent
 *
 * Accepts a natural language connectivity request, parses it into structured
 * intent, ranks available offers, and returns the ranked list.
 *
 * This is the "connectivity intelligence" entry point. The customer doesn't
 * choose a product — they express a need, and the system recommends options.
 *
 * Flow:
 *   1. Customer submits raw text (e.g., "I need internet in Accra today")
 *   2. parseIntent() extracts structured intent (deterministic, no AI)
 *   3. rankOffers() scores all active offers against the intent
 *   4. An IntentRequest record is created (for analytics + purchase flow)
 *   5. Returns the parsed intent + ranked offers
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { parseIntent, summarizeIntent } from "@/lib/commerce/intent-parser";
import { rankOffers } from "@/lib/commerce/ranking-engine";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { rawText } = body;

  if (!rawText || typeof rawText !== "string") {
    return NextResponse.json({ error: "rawText is required" }, { status: 400 });
  }

  // Step 1: Parse the natural language intent
  const parsed = parseIntent(rawText);

  // Step 2: Rank offers against the parsed intent
  const ranking = await rankOffers({
    tenantId: ctx.tenantId,
    customerId: user.id,
    capabilityType: parsed.capabilityType,
    desiredSpec: parsed.desiredSpec,
    location: parsed.location,
    maxPriceMinor: parsed.maxPriceMinor,
  });

  // Step 3: Create an IntentRequest record
  const intentRequest = await db.intentRequest.create({
    data: {
      tenantId: ctx.tenantId,
      customerId: user.id,
      rawText,
      parsedIntent: JSON.stringify(parsed),
      rankedOfferIds: JSON.stringify(ranking.ranked.slice(0, 20).map((r) => r.offerId)),
      status: "ranked",
    },
  });

  logger.info("intent.request_created", {
    intentId: intentRequest.id,
    tenantId: ctx.tenantId,
    confidence: parsed.confidence,
    rankedCount: ranking.ranked.length,
  });

  // Step 4: Return the parsed intent + ranked offers + summary
  return NextResponse.json({
    intentId: intentRequest.id,
    summary: summarizeIntent(parsed),
    confidence: parsed.confidence,
    parsed,
    ranked: ranking.ranked.slice(0, 10), // top 10
  });
}
