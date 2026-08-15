/**
 * Phase 4 — Offer Ranking API
 * POST /api/commerce/rank
 *
 * Resolves a customer's connectivity intent into a ranked list of offers.
 * The ranking is deterministic — the same inputs always produce the same
 * ranking.
 *
 * Request body:
 *   {
 *     capabilityType?: "INTERNET" | "ROAMING" | ...,
 *     desiredSpec?: { downloadMbps, uploadMbps, dataLimitBytes, ... },
 *     location?: { country, region, city, lat, lng },
 *     maxPriceMinor?: number
 *   }
 *
 * Response:
 *   {
 *     intentId: string,
 *     ranked: [{
 *       offerId, score, customerPriceMinor, matchReasons[],
 *       scores: { intentMatch, locationMatch, availability, price, margin, reliability },
 *       offer: { capabilityType, providerType, spec, coverage, ... }
 *     }, ...]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { rankOffers } from "@/lib/commerce/ranking-engine";
import type { OfferSpec, CustomerLocation } from "@/lib/commerce/ranking-engine";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { capabilityType, desiredSpec, location, maxPriceMinor } = body;

  const result = await rankOffers({
    tenantId: ctx.tenantId,
    customerId: user.id,
    capabilityType: capabilityType ?? undefined,
    desiredSpec: desiredSpec as OfferSpec | undefined,
    location: location as CustomerLocation | undefined,
    maxPriceMinor: maxPriceMinor ?? undefined,
  });

  return NextResponse.json(result);
}
