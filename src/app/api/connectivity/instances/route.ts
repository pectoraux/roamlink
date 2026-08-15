/**
 * Phase 5.1E — Provider Instance Management API
 * GET  /api/connectivity/instances — list instances for the tenant
 * POST /api/connectivity/instances — create a new provider instance
 *
 * Allows operators to add/manage their connectivity infrastructure:
 *   - MikroTik routers (WiFi/ISP)
 *   - eSIM supplier connections
 *
 * This is the API that powers the "Add Router" / "Add eSIM Supplier" UI
 * in the reseller portal. It uses the existing createProviderInstance()
 * function from the frozen kernel — no kernel changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createProviderInstance } from "@/lib/connectivity";
import { logger } from "@/lib/logger";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const instances = await db.connectivityProviderInstance.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      providerType: true,
      name: true,
      status: true,
      configuration: true,
      configurationKey: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ instances });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { providerType, name, endpoint, configurationKey, apiVersion, region } = body;

  if (!providerType || !name) {
    return NextResponse.json(
      { error: "Missing required fields: providerType, name" },
      { status: 400 },
    );
  }

  // Validate providerType
  if (!["mikrotik", "esim"].includes(providerType)) {
    return NextResponse.json(
      { error: `Unsupported providerType: ${providerType}. Supported: mikrotik, esim` },
      { status: 400 },
    );
  }

  // Build the configuration object (non-secret config — secrets go in env vars via configurationKey)
  const configuration: Record<string, unknown> = {};
  if (endpoint) configuration.endpoint = endpoint;
  if (apiVersion) configuration.apiVersion = apiVersion;
  if (region) configuration.region = region;

  try {
    const instance = await createProviderInstance({
      tenantId: ctx.tenantId,
      providerType,
      name,
      configuration: Object.keys(configuration).length > 0 ? configuration : undefined,
      configurationKey: configurationKey ?? undefined,
      userId: user.id,
    });

    logger.info("provider_instance.created", {
      tenantId: ctx.tenantId,
      instanceId: instance.id,
      providerType,
      name,
    });

    return NextResponse.json({ instance }, { status: 201 });
  } catch (err) {
    logger.error("provider_instance.creation_failed", {
      tenantId: ctx.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to create provider instance" },
      { status: 500 },
    );
  }
}
