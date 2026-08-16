/**
 * Protocol API — Intent
 * POST /api/v1/connectivity/intents
 *
 * Creates a connectivity intent, optionally runs the decision engine,
 * and returns the decision + ranked offers.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { makeDecision } from "@/lib/control-plane/decision-engine";
import { createSession } from "@/lib/control-plane/session-manager";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { rawText, capabilityType, desiredSpec, location, maxPriceMinor, mode } = body;

  // Create an IntentRequest (existing model from Phase 6)
  const intentRequest = await db.intentRequest.create({
    data: {
      tenantId: ctx.tenantId,
      customerId: user.id,
      rawText: rawText ?? null,
      parsedIntent: JSON.stringify({ capabilityType, desiredSpec, location, maxPriceMinor, mode }),
      status: "pending",
    },
  });

  // Create a session if mode is automatic
  let sessionId: string | undefined;
  if (mode === "AUTOMATIC") {
    const session = await createSession({
      subjectId: user.id,
      intentId: intentRequest.id,
    });
    sessionId = session.id;
  }

  // Run the decision engine
  const decision = await makeDecision({
    tenantId: ctx.tenantId,
    subjectId: user.id,
    intentId: intentRequest.id,
    sessionId,
    rawText,
    capabilityType,
    desiredSpec,
    location,
    maxPriceMinor,
  });

  // Update the intent request with results
  await db.intentRequest.update({
    where: { id: intentRequest.id },
    data: {
      rankedOfferIds: JSON.stringify(decision.rankedOffers),
      selectedOfferId: decision.targetOfferId ?? null,
      status: "ranked",
    },
  });

  return NextResponse.json({
    intentId: intentRequest.id,
    sessionId,
    decision,
  });
}
