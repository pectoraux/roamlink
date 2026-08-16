/**
 * Phase 9.3.1 — Edge Policy Context (context snapshot, not base policy)
 * POST /api/v1/connectivity/edge/policy-context  — update device context
 * GET  /api/v1/connectivity/edge/policy-context  — read device context + effective policy
 *
 * Phase 9.3.1 architectural fix:
 *   - Device context (batterySaver, roaming, workMode) is a CONTEXT SNAPSHOT,
 *     NOT authoritative policy. It does NOT overwrite the user's base policy.
 *   - The decision engine derives an effective policy from base + device context.
 *   - Only EXPLICIT USER OVERRIDES (autoSwitchEnabled, connectivityPreference)
 *     are written to the base policy — they are user decisions, not transient.
 *   - Context updates are versioned/timestamp-fenced to prevent network
 *     reordering from regressing the context.
 *   - GET derives deviceId from the authenticated device, not a query param.
 *
 *   Mobile context → EdgePolicyContext (snapshot) → Effective Policy → Decision
 *
 * NOT: Mobile context → overwrite base policy
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createOrUpdatePolicy, getPolicy } from "@/lib/control-plane/policy-engine";
import { deriveEffectivePolicy } from "@/lib/control-plane/effective-policy";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// POST — update device context (versioned, timestamp-fenced)
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { deviceId, context, observedAt } = body;

  if (!deviceId || typeof deviceId !== "string") {
    return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  }
  if (!context || typeof context !== "object") {
    return NextResponse.json({ error: "context object is required" }, { status: 400 });
  }

  // Validate device ownership (strict — deviceId must belong to authenticated user)
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device || device.userId !== user.id) {
    return NextResponse.json({ error: "Device not registered to this user" }, { status: 403 });
  }

  // Phase 9.3.1: Timestamp fencing — reject stale updates.
  // If the device sends observedAt, and it's older than the current
  // policyContextObservedAt, reject the update (network reordering).
  const contextObservedAt = observedAt ? new Date(observedAt) : new Date();
  if (device.policyContextObservedAt && contextObservedAt < device.policyContextObservedAt) {
    logger.warn("edge.policy_context_stale_rejected", {
      deviceId, userId: user.id,
      requestObservedAt: contextObservedAt.toISOString(),
      currentObservedAt: device.policyContextObservedAt.toISOString(),
    });
    return NextResponse.json({
      ok: false,
      rejected: "stale",
      reason: "Context update is older than the current context — network reordering detected",
      currentObservedAt: device.policyContextObservedAt.toISOString(),
    }, { status: 409 });
  }

  // Phase 9.3.1: Persist the context as a SNAPSHOT (not authoritative policy).
  // Increment the version + update the observed timestamp.
  const newVersion = (device.policyContextVersion ?? 0) + 1;
  await db.edgeDevice.update({
    where: { deviceId },
    data: {
      policyContext: JSON.stringify(context),
      policyContextUpdatedAt: new Date(),
      policyContextObservedAt: contextObservedAt,
      policyContextVersion: newVersion,
    },
  });

  // Phase 9.3.1: Only EXPLICIT USER OVERRIDES are written to the base policy.
  // Transient device context (batterySaver, workMode, roaming) does NOT
  // overwrite the base policy — it's applied at decision time via
  // deriveEffectivePolicy().
  //
  // Explicit user overrides:
  //   - autoSwitchEnabled=false → mode=manual (user decision)
  //   - connectivityPreference → preset (user decision)
  //
  // Transient device context (NOT written to base policy):
  //   - batterySaver (physical state, not a preference)
  //   - workMode (session state, not a permanent choice)
  //   - avoidCellular (applied at decision time)
  //   - allowRoaming (applied at decision time)
  try {
    // Only call createOrUpdatePolicy if there's a genuine preset or mode override.
    // Calling it with just { subjectId, mode } would use MANUAL as the base
    // preset and overwrite the existing RELIABLE/CHEAPEST policy.
    const hasPresetOverride = context.connectivityPreference === "RELIABLE"
      || context.connectivityPreference === "CHEAPEST"
      || context.connectivityPreference === "BALANCED";
    const hasModeOverride = context.autoSwitchEnabled === false || context.autoSwitchEnabled === true;

    if (hasPresetOverride || hasModeOverride) {
      const basePolicyUpdates: Parameters<typeof createOrUpdatePolicy>[0] = {
        subjectId: user.id,
      };

      // Explicit user override: autoSwitchEnabled
      if (context.autoSwitchEnabled === false) {
        basePolicyUpdates.mode = "manual";
      } else if (context.autoSwitchEnabled === true) {
        basePolicyUpdates.mode = "automatic";
      }

      // Explicit user override: connectivityPreference → base preset
      if (context.connectivityPreference === "RELIABLE") {
        basePolicyUpdates.preset = "RELIABLE";
      } else if (context.connectivityPreference === "CHEAPEST") {
        basePolicyUpdates.preset = "CHEAPEST";
      } else if (context.connectivityPreference === "BALANCED") {
        basePolicyUpdates.preset = "WORK";
      }

      await createOrUpdatePolicy(basePolicyUpdates);
      logger.info("edge.base_policy_updated", {
        deviceId, userId: user.id,
        overrides: { mode: basePolicyUpdates.mode, preset: basePolicyUpdates.preset },
      });
    }

    // Derive the effective policy (base + device context) for the response
    const effective = await deriveEffectivePolicy(user.id, deviceId);

    logger.info("edge.policy_context_updated", {
      deviceId, userId: user.id, version: newVersion,
      basePreset: effective.basePreset,
      effectivePreset: effective.effectivePreset,
      derivationReason: effective.derivationReason,
    });

    return NextResponse.json({
      ok: true,
      context,
      version: newVersion,
      effectivePolicy: {
        basePreset: effective.basePreset,
        effectivePreset: effective.effectivePreset,
        derivationReason: effective.derivationReason,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "policy update failed" },
      { status: 400 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET — read device context + effective policy (strict owner scoping)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Phase 9.3.1: Derive deviceId from the authenticated user's registered
  // devices, not from a query param. This prevents a user from reading
  // another user's device context.
  //
  // If deviceId is provided as a query param, validate ownership.
  // If not provided, use the user's most recently active device.
  const deviceIdParam = req.nextUrl.searchParams.get("deviceId");
  let device = null;

  if (deviceIdParam) {
    // Validate ownership — must belong to authenticated user
    device = await db.edgeDevice.findUnique({ where: { deviceId: deviceIdParam } });
    if (!device || device.userId !== user.id) {
      return NextResponse.json({ error: "Device not registered to this user" }, { status: 403 });
    }
  } else {
    // No deviceId provided — use the user's most recently active device
    device = await db.edgeDevice.findFirst({
      where: { userId: user.id },
      orderBy: { lastSeenAt: "desc" },
    });
    if (!device) {
      return NextResponse.json({ error: "No registered device found" }, { status: 404 });
    }
  }

  // Read the persisted device context (snapshot)
  const context: EdgePolicyContext = device.policyContext
    ? JSON.parse(device.policyContext)
    : {};

  // Read the base policy (authoritative — user's explicit choice)
  const basePolicy = await getPolicy(user.id);

  // Derive the effective policy (base + device context)
  const effective = await deriveEffectivePolicy(user.id, device.deviceId);

  return NextResponse.json({
    context,
    policyContextUpdatedAt: device.policyContextUpdatedAt?.toISOString() ?? null,
    policyContextVersion: device.policyContextVersion ?? 0,
    policyContextObservedAt: device.policyContextObservedAt?.toISOString() ?? null,
    deviceId: device.deviceId,
    basePolicy: {
      mode: basePolicy.mode,
      preset: effective.basePreset,
      maxAutoSpendMinor: basePolicy.maxAutoSpendMinor,
      minReliability: basePolicy.minReliability,
      switchHysteresis: basePolicy.switchHysteresis,
      preferredTransports: basePolicy.preferredTransports,
      requireUserApprovalForPurchase: basePolicy.requireUserApprovalForPurchase,
      neverInterruptActiveCall: basePolicy.neverInterruptActiveCall,
    },
    effectivePolicy: {
      preset: effective.effectivePreset,
      mode: effective.mode,
      minReliability: effective.minReliability,
      switchHysteresis: effective.switchHysteresis,
      preferredTransports: effective.preferredTransports,
      derivationReason: effective.derivationReason,
    },
  });
}
