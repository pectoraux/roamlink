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
 *
 * Phase 12.3.5: Uses the canonical v1 response helpers so the X-API-Version
 * + X-API-Stable headers are enforced at the response boundary. Errors are
 * thrown as AppError so the catch handler emits the canonical envelope. The
 * stale-context 409 response keeps its structured `{ ok: false, rejected: "stale" }`
 * body — the device keys off that field to back off.
 */

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRequestId, apiV1SuccessResponse, apiV1ErrorResponse } from "@/lib/api/protocol";
import { enforceRateLimit } from "@/lib/api/rate-limit-helper";
import { requireTenantContext } from "@/lib/tenant/context";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createOrUpdatePolicy, getPolicy } from "@/lib/control-plane/policy-engine";
import { deriveEffectivePolicy } from "@/lib/control-plane/effective-policy";
import { AppError } from "@/lib/errors";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// POST — update device context (versioned, timestamp-fenced)
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "No active session — authentication required", 401, "Authentication required.");

    // Phase 12.4.6.2: Resolve tenant context for rate limiting (after auth).
    const tenantCtx = await requireTenantContext(user);
    const rateLimitResult = await enforceRateLimit({
      tenantId: tenantCtx.tenantId,
      path: new URL(req.url).pathname,
    }, requestId);
    if (!rateLimitResult.allowed) return rateLimitResult.response!;

    const body = await req.json();
    const { deviceId, context, observedAt } = body;

    if (!deviceId || typeof deviceId !== "string") {
      throw new AppError("validation", "deviceId is required", 400, "deviceId is required.");
    }
    if (!context || typeof context !== "object") {
      throw new AppError("validation", "context object is required", 400, "context object is required.");
    }

    // Validate device ownership (strict — deviceId must belong to authenticated user)
    const device = await db.edgeDevice.findUnique({ where: { deviceId } });
    if (!device || device.userId !== user.id) {
      throw new AppError("authorization", "Device not registered to this user", 403, "Device not registered to this user.");
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
      // Preserve the structured stale-rejection body (NOT the canonical error
      // envelope) — the device keys off `rejected: "stale"` to back off.
      return apiV1SuccessResponse({
        ok: false,
        rejected: "stale",
        reason: "Context update is older than the current context — network reordering detected",
        currentObservedAt: device.policyContextObservedAt.toISOString(),
      }, requestId, 409);
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

    return apiV1SuccessResponse({
      ok: true,
      context,
      version: newVersion,
      effectivePolicy: {
        basePreset: effective.basePreset,
        effectivePreset: effective.effectivePreset,
        derivationReason: effective.derivationReason,
      },
    }, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}

// ---------------------------------------------------------------------------
// GET — read device context + effective policy (strict owner scoping)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "No active session — authentication required", 401, "Authentication required.");

    // Phase 12.4.6.2: Resolve tenant context for rate limiting (after auth).
    const tenantCtx = await requireTenantContext(user);
    const rateLimitResult = await enforceRateLimit({
      tenantId: tenantCtx.tenantId,
      path: new URL(req.url).pathname,
    }, requestId);
    if (!rateLimitResult.allowed) return rateLimitResult.response!;

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
        throw new AppError("authorization", "Device not registered to this user", 403, "Device not registered to this user.");
      }
    } else {
      // No deviceId provided — use the user's most recently active device
      device = await db.edgeDevice.findFirst({
        where: { userId: user.id },
        orderBy: { lastSeenAt: "desc" },
      });
      if (!device) {
        throw new AppError("not_found", "No registered device found", 404, "No registered device found.");
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

    return apiV1SuccessResponse({
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
    }, requestId);
  } catch (err) {
    return apiV1ErrorResponse(err, requestId);
  }
}
