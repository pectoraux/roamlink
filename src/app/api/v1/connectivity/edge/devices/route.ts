/**
 * Phase 9.1 — Edge Device Registration
 * POST /api/v1/connectivity/edge/devices
 *
 * Binds a client-generated deviceId to the authenticated user. Subsequent
 * observations from this deviceId are validated against this ownership.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { registerEdgeDevice } from "@/lib/control-plane/edge-ingestion";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { deviceId, platform, appVersion } = body;

  if (!deviceId || typeof deviceId !== "string") {
    return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  }
  if (!platform || !["ios", "android", "web", "unknown"].includes(platform)) {
    return NextResponse.json({ error: "platform must be ios|android|web|unknown" }, { status: 400 });
  }
  if (!appVersion || typeof appVersion !== "string") {
    return NextResponse.json({ error: "appVersion is required" }, { status: 400 });
  }

  try {
    const result = await registerEdgeDevice({ userId: user.id, deviceId, platform, appVersion });
    return NextResponse.json(result, { status: result.registered ? 201 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "registration failed" },
      { status: 400 },
    );
  }
}
