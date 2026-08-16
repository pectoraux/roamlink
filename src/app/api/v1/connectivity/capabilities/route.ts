/**
 * Protocol API — Capabilities
 * GET  /api/v1/connectivity/capabilities — discover capabilities
 * POST /api/v1/connectivity/capabilities — advertise a capability
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { advertiseCapability, discoverCapabilities } from "@/lib/control-plane/capability-registry";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") ?? undefined;
  const country = searchParams.get("country") ?? undefined;
  const city = searchParams.get("city") ?? undefined;
  const minReliability = searchParams.get("minReliability")
    ? parseFloat(searchParams.get("minReliability")!)
    : undefined;

  const capabilities = await discoverCapabilities({
    tenantId: ctx.tenantId,
    type,
    country,
    city,
    minReliability,
  });

  return NextResponse.json({ capabilities });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { providerInstanceId, type, providerType, bandwidth, latency, reliability, geographicCoverage, mobility, metering } = body;

  if (!providerInstanceId || !type || !providerType) {
    return NextResponse.json({ error: "providerInstanceId, type, and providerType are required" }, { status: 400 });
  }

  const result = await advertiseCapability({
    tenantId: ctx.tenantId,
    providerInstanceId,
    type,
    providerType,
    bandwidth,
    latency,
    reliability,
    geographicCoverage,
    mobility,
    metering,
  });

  return NextResponse.json({ capability: result }, { status: 201 });
}
