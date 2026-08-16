/**
 * Phase 9.1 — Edge Observation Upload
 * POST /api/v1/connectivity/edge/observations
 *
 * Accepts a batch of connectivity observations from a mobile device. The
 * server:
 *   1. Authenticates the user (session cookie)
 *   2. Validates device ownership (deviceId → user)
 *   3. Dedupes by observationId + (deviceId, sequence)
 *   4. Persists immutable EdgeObservationRecord
 *   5. Projects to ConnectivityMeasurement (source=DEVICE)
 *   6. Emits MEASUREMENT_RECEIVED (existing reevaluation path)
 *
 * The device NEVER submits health/decisions. The server derives everything.
 * Device-supplied resourceId is a HINT — validated against the session's
 * active resource.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ingestEdgeObservationBatch } from "@/lib/control-plane/edge-ingestion";
import type { EdgeObservationBatch } from "@roamlink/shared";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { deviceId, observations } = body;

  if (!deviceId || typeof deviceId !== "string") {
    return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  }
  if (!Array.isArray(observations) || observations.length === 0) {
    return NextResponse.json({ error: "observations array is required" }, { status: 400 });
  }
  if (observations.length > 100) {
    return NextResponse.json({ error: "max 100 observations per batch" }, { status: 413 });
  }

  try {
    const ack = await ingestEdgeObservationBatch(user.id, { deviceId, observations } as EdgeObservationBatch);
    return NextResponse.json(ack, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ingestion failed";
    const status = message.includes("ownership") || message.includes("impersonation") ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
