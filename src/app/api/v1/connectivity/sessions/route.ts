/**
 * Protocol API — Sessions
 * GET  /api/v1/connectivity/sessions — list sessions for the user (tenant-scoped)
 * POST /api/v1/connectivity/sessions — create a session
 *
 * Phase 12.2 P0-5: GET now filters by ctx.tenantId via entitlement join.
 * Phase 12.2: POST verifies entitlementId belongs to ctx.tenantId before session creation.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createSession } from "@/lib/control-plane/session-manager";
import { db } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  // Phase 12.2 P0-5: Filter sessions by the authenticated tenant.
  // Sessions are linked to a tenant via their entitlement (ConnectivityEntitlement.tenantId).
  // We query sessions where the user is the subject AND the session's entitlement
  // belongs to ctx.tenantId. Sessions without an entitlementId are excluded
  // (they have no tenant authority).
  const sessions = await db.connectivitySession.findMany({
    where: {
      subjectId: user.id,
      entitlementId: { not: null },
      // We can't do a direct join in Prisma findMany, so we filter in two steps:
      // 1. Get all entitlement IDs for this tenant + user.
      // 2. Filter sessions by those entitlement IDs.
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      measurements: { orderBy: { capturedAt: "desc" }, take: 5 },
      actions: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });

  // Phase 12.2 P0-5: Further filter by tenant via entitlement lookup.
  const tenantEntitlementIds = await db.connectivityEntitlement.findMany({
    where: { tenantId: ctx.tenantId, userId: user.id },
    select: { id: true },
  });
  const entitlementIdSet = new Set(tenantEntitlementIds.map((e) => e.id));
  const tenantScopedSessions = sessions.filter((s) => s.entitlementId && entitlementIdSet.has(s.entitlementId));

  return NextResponse.json({ sessions: tenantScopedSessions });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { intentId, entitlementId, policyId } = body;

  // Phase 12.2: Verify entitlementId belongs to this tenant + user.
  if (!entitlementId) {
    return NextResponse.json({ error: "entitlementId is required for tenant-scoped session creation" }, { status: 400 });
  }
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: entitlementId },
    select: { tenantId: true, userId: true },
  });
  if (!entitlement) {
    return NextResponse.json({ error: "Entitlement not found" }, { status: 404 });
  }
  if (entitlement.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Entitlement does not belong to this tenant" }, { status: 403 });
  }
  if (entitlement.userId !== user.id) {
    return NextResponse.json({ error: "Entitlement does not belong to this user" }, { status: 403 });
  }

  const session = await createSession({
    subjectId: user.id,
    intentId,
    entitlementId,
    policyId,
  });

  return NextResponse.json({ session }, { status: 201 });
}
