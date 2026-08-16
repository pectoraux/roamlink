/**
 * Phase 9.1 — Edge Policy Context
 * POST /api/v1/connectivity/edge/policy-context
 *
 * The device reports CONTEXT (battery saver is on), not DECISIONS (switch to
 * WiFi). The server-side policy engine remains authoritative.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { deviceId, context } = body;

  if (!deviceId || typeof deviceId !== "string") {
    return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  }
  if (!context || typeof context !== "object") {
    return NextResponse.json({ error: "context object is required" }, { status: 400 });
  }

  // Validate device ownership
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device || device.userId !== user.id) {
    return NextResponse.json({ error: "Device not registered to this user" }, { status: 403 });
  }

  // The device reports context hints — translate to policy updates.
  // The server-side policy engine is authoritative; these are HINTS.
  // We update the user's policy with the hints, but the policy engine
  // still makes the final decision.
  try {
    // Map context hints to policy parameters
    const policyUpdates: Parameters<typeof createOrUpdatePolicy>[0] = {
      subjectId: user.id,
      mode: context.autoSwitchEnabled === false ? "manual" : "automatic",
    };

    if (context.batterySaver) {
      // Battery saver → BATTERY preset (rarely switch to save battery)
      policyUpdates.preset = "BATTERY";
    } else if (context.connectivityPreference === "RELIABLE") {
      policyUpdates.preset = "RELIABLE";
    } else if (context.connectivityPreference === "CHEAPEST") {
      policyUpdates.preset = "CHEAPEST";
    } else if (context.workMode) {
      policyUpdates.preset = "WORK";
    }

    await createOrUpdatePolicy(policyUpdates);

    logger.info("edge.policy_context_updated", { deviceId, userId: user.id, context });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "policy update failed" },
      { status: 400 },
    );
  }
}
