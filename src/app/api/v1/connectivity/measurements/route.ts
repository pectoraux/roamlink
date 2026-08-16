/**
 * Protocol API — Measurements
 * POST /api/v1/connectivity/measurements
 *
 * Records a quality/usage/availability measurement for a session or resource.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { recordMeasurement } from "@/lib/control-plane/session-manager";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { sessionId, resourceId, providerInstanceId, type, metrics, freshness, source, confidence } = body;

  if (!type || !["USAGE", "QUALITY", "AVAILABILITY"].includes(type)) {
    return NextResponse.json({ error: "type must be USAGE, QUALITY, or AVAILABILITY" }, { status: 400 });
  }

  if (!metrics || typeof metrics !== "object") {
    return NextResponse.json({ error: "metrics object is required" }, { status: 400 });
  }

  const measurement = await recordMeasurement({
    sessionId,
    resourceId,
    providerInstanceId,
    type,
    metrics,
    freshness,
    source,
    confidence,
  });

  return NextResponse.json({ measurement }, { status: 201 });
}
