/**
 * Phase 9.4 — Intent Detail API
 * GET    /api/v1/connectivity/intents/[intentId] — get intent history
 * POST   /api/v1/connectivity/intents/[intentId]/cancel — cancel intent
 * POST   /api/v1/connectivity/intents/[intentId]/supersede — create new version
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getIntentHistory, cancelIntent, createIntent, emitIntentReevaluationEvent } from "@/lib/control-plane/intent-service";

// GET — intent history
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { intentId } = await params;
  const history = await getIntentHistory(user.id, intentId);

  return NextResponse.json({ intentId, history });
}

// POST — supersede or cancel (based on body.action)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { intentId } = await params;
  const body = await req.json();
  const { action, expectedVersion, rawText, capabilityType, desiredSpec, location, maxPriceMinor, mode, priority, expiresAt, deviceId } = body;

  if (action === "cancel") {
    const result = await cancelIntent(user.id, intentId, expectedVersion);
    if (result.rejected) {
      return NextResponse.json({ error: result.rejected, ...result }, { status: 409 });
    }
    return NextResponse.json(result);
  }

  if (action === "supersede") {
    const result = await createIntent({
      subjectId: user.id,
      deviceId,
      rawText,
      capabilityType,
      desiredSpec,
      location,
      maxPriceMinor,
      mode,
      priority,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      supersedesIntentId: intentId,
      expectedVersion,
    });

    if (result.rejected) {
      const status = result.rejected === "stale-version" ? 409 : 400;
      return NextResponse.json({ error: result.rejected, ...result }, { status });
    }

    // Emit reevaluation signal
    await emitIntentReevaluationEvent(result.intentId, result.version, user.id);

    return NextResponse.json(result, { status: 200 });
  }

  return NextResponse.json({ error: "action must be 'cancel' or 'supersede'" }, { status: 400 });
}
