/**
 * Protocol API — Sessions
 * GET  /api/v1/connectivity/sessions — list sessions for the user
 * POST /api/v1/connectivity/sessions — create a session
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createSession, getActiveSessionForSubject } from "@/lib/control-plane/session-manager";
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

  const session = await createSession({
    subjectId: user.id,
    intentId,
    entitlementId,
    policyId,
  });

  return NextResponse.json({ session }, { status: 201 });
}
