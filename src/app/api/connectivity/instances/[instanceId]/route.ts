/**
 * Phase 5.1E — Provider Instance Detail API
 * GET    /api/connectivity/instances/[instanceId] — get instance details
 * PATCH  /api/connectivity/instances/[instanceId] — update (e.g., status)
 * DELETE /api/connectivity/instances/[instanceId] — deactivate
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { instanceId } = await params;
  const instance = await db.connectivityProviderInstance.findFirst({
    where: { id: instanceId, tenantId: ctx.tenantId },
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

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  return NextResponse.json({ instance });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { instanceId } = await params;
  const body = await req.json();

  const instance = await db.connectivityProviderInstance.updateMany({
    where: { id: instanceId, tenantId: ctx.tenantId },
    data: {
      ...(body.name && { name: body.name }),
      ...(body.status && { status: body.status }),
      ...(body.configurationKey !== undefined && { configurationKey: body.configurationKey }),
    },
  });

  if (instance.count === 0) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { instanceId } = await params;
  // Soft delete: mark as inactive rather than actually deleting
  const instance = await db.connectivityProviderInstance.updateMany({
    where: { id: instanceId, tenantId: ctx.tenantId },
    data: { status: "inactive" },
  });

  if (instance.count === 0) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
