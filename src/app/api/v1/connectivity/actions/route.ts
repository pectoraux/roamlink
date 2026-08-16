/**
 * Protocol API — Actions
 * POST /api/v1/connectivity/actions
 *
 * Creates and optionally executes a connectivity action.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createAction, executeAction } from "@/lib/control-plane/action-executor";

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
