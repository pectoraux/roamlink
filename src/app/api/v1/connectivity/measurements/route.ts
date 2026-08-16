/**
 * Protocol API — Measurements
 * POST /api/v1/connectivity/measurements
 *
 * Phase 8.6: records a measurement through the canonical ingestion path
 * (ingestMeasurement), which validates source provenance, computes freshness,
 * derives persisted ResourceHealth, and emits re-evaluation events.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { ingestMeasurement, isValidSource } from "@/lib/control-plane/measurement-store";

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
