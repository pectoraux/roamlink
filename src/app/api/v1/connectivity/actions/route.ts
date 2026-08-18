/**
 * Protocol API — Actions
 * POST /api/v1/connectivity/actions
 *
 * Creates and optionally executes a connectivity action.
 *
 * Phase 12.2: Verifies the session belongs to ctx.tenantId before creating/executing actions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createAction, executeAction } from "@/lib/control-plane/action-executor";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { sessionId, decisionId, type, targetResourceId, reason, policyVersion, execute } = body;

  if (!sessionId || !type) {
    return NextResponse.json({ error: "sessionId and type are required" }, { status: 400 });
  }

  const validTypes = ["DISCOVER", "RESERVE", "ACTIVATE", "SWITCH", "SUSPEND", "RESUME", "RENEW", "RELEASE", "TRANSFER"];
  if (!validTypes.includes(type)) {
    return NextResponse.json({ error: `Invalid type. Valid: ${validTypes.join(", ")}` }, { status: 400 });
  }

  // Phase 12.2: Verify the session belongs to this tenant.
  // The session's subjectId is the user; the session's entitlement links to a
  // tenant via ConnectivityEntitlement.tenantId.
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { subjectId: true, entitlementId: true },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (session.subjectId !== user.id) {
    return NextResponse.json({ error: "Session does not belong to this user" }, { status: 403 });
  }
  // Phase 12.2 P0-6: Verify the session has an entitlement AND it belongs to this tenant.
  // A tenantless session (entitlementId = null) is rejected — the API requires
  // an authoritative tenant relationship for every action-bearing session.
  if (!session.entitlementId) {
    return NextResponse.json({ error: "Session has no entitlement — cannot establish tenant authority" }, { status: 403 });
  }
  const entitlement = await db.connectivityEntitlement.findUnique({
    where: { id: session.entitlementId },
    select: { tenantId: true },
  });
  if (!entitlement || entitlement.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Session entitlement does not belong to this tenant" }, { status: 403 });
  }

  const action = await createAction({
    sessionId,
    decisionId,
    type,
    targetResourceId,
    reason,
    policyVersion,
  });

  // Optionally execute immediately
  let execution;
  if (execute) {
    execution = await executeAction(action.id);
  }

  return NextResponse.json({ action, execution }, { status: 201 });
}
