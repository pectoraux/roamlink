/**
 * Phase 9.3 — Edge Policy Context (read/write)
 * POST /api/v1/connectivity/edge/policy-context  — update context
 * GET  /api/v1/connectivity/edge/policy-context?deviceId=...  — read context
 *
 * The device reports CONTEXT (battery saver is on), not DECISIONS (switch to
 * WiFi). The server-side policy engine remains authoritative.
 *
 *   Mobile context → EdgePolicyContext → Server policy engine → Decision → Action
 *
 * NOT: Mobile context → mobile decides "switch to Wi-Fi"
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createOrUpdatePolicy, getPolicy } from "@/lib/control-plane/policy-engine";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// POST — update policy context (device reports context, server applies)
// ---------------------------------------------------------------------------

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

  // Phase 9.3: Persist the policy context on the device record
  const contextJson = JSON.stringify(context);
  await db.edgeDevice.update({
    where: { deviceId },
    data: {
      policyContext: contextJson,
      policyContextUpdatedAt: new Date(),
    },
  });

  // The device reports context hints — translate to policy updates.
  // The server-side policy engine is authoritative; these are HINTS.
  try {
    const policyUpdates: Parameters<typeof createOrUpdatePolicy>[0] = {
      subjectId: user.id,
      mode: context.autoSwitchEnabled === false ? "manual" : "automatic",
    };

    // Map context hints to policy presets
    if (context.batterySaver) {
      policyUpdates.preset = "BATTERY";
    } else if (context.connectivityPreference === "RELIABLE") {
      policyUpdates.preset = "RELIABLE";
    } else if (context.connectivityPreference === "CHEAPEST") {
      policyUpdates.preset = "CHEAPEST";
    } else if (context.workMode) {
      policyUpdates.preset = "WORK";
    }

    // Apply transport preferences
    if (context.avoidCellular) {
      policyUpdates.preferredTransports = ["WIFI"];
    } else if (context.connectivityPreference === "FASTEST") {
      policyUpdates.preferredTransports = ["WIFI", "CELLULAR"];
    }

    await createOrUpdatePolicy(policyUpdates);

    logger.info("edge.policy_context_updated", {
      deviceId, userId: user.id, context, preset: policyUpdates.preset,
    });

    return NextResponse.json({ ok: true, context });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "policy update failed" },
      { status: 400 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET — read current policy context (for mobile settings UI)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const deviceId = req.nextUrl.searchParams.get("deviceId");
  if (!deviceId) {
    return NextResponse.json({ error: "deviceId query parameter is required" }, { status: 400 });
  }

  // Validate device ownership
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device || device.userId !== user.id) {
    return NextResponse.json({ error: "Device not registered to this user" }, { status: 403 });
  }

  // Read the persisted policy context
  const context: EdgePolicyContext = device.policyContext
    ? JSON.parse(device.policyContext)
    : {};

  // Also include the current server-side policy (so the UI shows what the
  // server actually applied — not just what the device sent)
  const policy = await getPolicy(user.id);

  return NextResponse.json({
    context,
    policyContextUpdatedAt: device.policyContextUpdatedAt?.toISOString() ?? null,
    policy: {
      mode: policy.mode,
      preset: (policy as Record<string, unknown>).preset ?? null,
      maxAutoSpendMinor: policy.maxAutoSpendMinor,
      minReliability: policy.minReliability,
      switchHysteresis: policy.switchHysteresis,
      preferredTransports: policy.preferredTransports,
      requireUserApprovalForPurchase: policy.requireUserApprovalForPurchase,
      neverInterruptActiveCall: policy.neverInterruptActiveCall,
    },
  });
}
