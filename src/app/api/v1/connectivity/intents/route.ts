/**
 * Phase 9.4 — Intent API
 * POST /api/v1/connectivity/intents — create a new intent (or supersede)
 * GET  /api/v1/connectivity/intents — get current active intent
 *
 * The intent is a declarative request for an outcome. It is NOT a command.
 * Creating/updating an intent emits a reevaluation signal — it does NOT
 * directly invoke the action executor.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createIntent, getActiveIntent, emitIntentReevaluationEvent } from "@/lib/control-plane/intent-service";

// POST — create or supersede
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { rawText, capabilityType, desiredSpec, location, maxPriceMinor, mode, priority, expiresAt, deviceId, supersedesIntentId, expectedVersion, source, idempotencyKey } = body;

  if (!rawText && !capabilityType && !desiredSpec && !location) {
    return NextResponse.json({ error: "At least one of rawText, capabilityType, desiredSpec, or location is required" }, { status: 400 });
  }

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
    source: source ?? "USER",
    supersedesIntentId,
    expectedVersion,
    idempotencyKey,
  });

  if (result.rejected) {
    const status = result.rejected === "stale-version" || result.rejected === "concurrent-supersession" ? 409 : 400;
    return NextResponse.json({ error: result.rejected, intentId: result.intentId, version: result.version }, { status });
  }

  // Emit reevaluation signal (does NOT directly invoke action executor)
  await emitIntentReevaluationEvent(result.intentId, result.version, user.id);

  return NextResponse.json(result, { status: result.version === 1 ? 201 : 200 });
}

// GET — get current active intent
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const intent = await getActiveIntent(user.id);
  if (!intent) {
    return NextResponse.json({ intent: null });
  }

  return NextResponse.json({
    intent: {
      intentId: intent.intentId,
      version: intent.version,
      status: intent.status,
      payload: intent.payload,
      expiresAt: intent.expiresAt?.toISOString() ?? null,
      createdAt: intent.createdAt.toISOString(),
    },
  });
}
