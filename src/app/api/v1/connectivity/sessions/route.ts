/**
 * Protocol API — Sessions
 * GET  /api/v1/connectivity/sessions — list sessions for the user
 * POST /api/v1/connectivity/sessions — create a session
 *
 * Phase 12.2: Verifies entitlementId belongs to ctx.tenantId before session creation.
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

  const sessions = await db.connectivitySession.findMany({
    where: { subjectId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      measurements: { orderBy: { capturedAt: "desc" }, take: 5 },
      actions: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });

  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { intentId, entitlementId, policyId } = body;

  // Phase 12.2: Verify entitlementId belongs to this tenant.
  if (entitlementId) {
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
  }

  const session = await createSession({
    subjectId: user.id,
    intentId,
    entitlementId,
    policyId,
  });

  return NextResponse.json({ session }, { status: 201 });
}
