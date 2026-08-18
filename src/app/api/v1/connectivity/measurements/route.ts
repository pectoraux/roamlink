/**
 * Protocol API — Measurements
 * POST /api/v1/connectivity/measurements
 *
 * Phase 8.6: records a measurement through the canonical ingestion path
 * (ingestMeasurement), which validates source provenance, computes freshness,
 * derives persisted ResourceHealth, and emits re-evaluation events.
 *
 * Phase 12.2: Verifies session/resource/providerInstance belong to ctx.tenantId.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { ingestMeasurement, isValidSource } from "@/lib/control-plane/measurement-store";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { sessionId, resourceId, providerInstanceId, type, metrics, source, confidence, capturedAt } = body;

  if (!type || !["USAGE", "QUALITY", "AVAILABILITY"].includes(type)) {
    return NextResponse.json({ error: "type must be USAGE, QUALITY, or AVAILABILITY" }, { status: 400 });
  }

  if (!metrics || typeof metrics !== "object") {
    return NextResponse.json({ error: "metrics object is required" }, { status: 400 });
  }

  // Phase 8.6: source provenance is required and validated.
  const resolvedSource = source ?? "PROVIDER";
  if (!isValidSource(resolvedSource)) {
    return NextResponse.json(
      {
        error: `Invalid source "${resolvedSource}". Must be one of: ADAPTER, DEVICE, PROBE, PROVIDER, DERIVED.`,
      },
      { status: 400 },
    );
  }

  // Phase 12.2: Verify session belongs to this tenant.
  if (sessionId) {
    const session = await db.connectivitySession.findUnique({
      where: { id: sessionId },
      select: { subjectId: true, entitlementId: true },
    });
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (session.subjectId !== user.id) return NextResponse.json({ error: "Session does not belong to this user" }, { status: 403 });
    if (session.entitlementId) {
      const ent = await db.connectivityEntitlement.findUnique({ where: { id: session.entitlementId }, select: { tenantId: true } });
      if (!ent || ent.tenantId !== ctx.tenantId) return NextResponse.json({ error: "Session entitlement does not belong to this tenant" }, { status: 403 });
    }
  }

  // Phase 12.2: Verify providerInstance belongs to this tenant.
  if (providerInstanceId) {
    const instance = await db.connectivityProviderInstance.findUnique({ where: { id: providerInstanceId }, select: { tenantId: true } });
    if (!instance || instance.tenantId !== ctx.tenantId) return NextResponse.json({ error: "Provider instance does not belong to this tenant" }, { status: 403 });
  }

  // Phase 12.2: Verify resource belongs to this tenant (via capability.tenantId).
  if (resourceId) {
    const resource = await db.protocolResource.findUnique({ where: { id: resourceId }, select: { capabilityId: true } });
    if (resource) {
      const cap = await db.protocolCapability.findUnique({ where: { id: resource.capabilityId }, select: { tenantId: true } });
      if (!cap || cap.tenantId !== ctx.tenantId) return NextResponse.json({ error: "Resource does not belong to this tenant" }, { status: 403 });
    }
  }

  try {
    const result = await ingestMeasurement({
      sessionId,
      resourceId,
      providerInstanceId,
      type,
      metrics,
      source: resolvedSource,
      confidence,
      capturedAt: capturedAt ? new Date(capturedAt) : undefined,
    });

    return NextResponse.json(
      {
        measurement: { id: result.measurementId },
        freshness: result.freshness,
        health: result.health,
        eventsEmitted: result.eventsEmitted,
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ingestion failed" },
      { status: 400 },
    );
  }
}
