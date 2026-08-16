/**
 * Protocol API — Policies
 * GET  /api/v1/connectivity/policies — get current user's policy
 * POST /api/v1/connectivity/policies — create/update policy
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createOrUpdatePolicy, getPolicy, POLICY_PRESETS } from "@/lib/control-plane/policy-engine";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const policy = await getPolicy(user.id);
  return NextResponse.json({ policy, availablePresets: Object.keys(POLICY_PRESETS) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { preset, mode, maxAutoSpendMinor, preferredTransports, minReliability, switchHysteresis, requireUserApprovalForPurchase, neverInterruptActiveCall } = body;

  const result = await createOrUpdatePolicy({
    subjectId: user.id,
    preset,
    mode,
    maxAutoSpendMinor,
    preferredTransports,
    minReliability,
    switchHysteresis,
    requireUserApprovalForPurchase,
    neverInterruptActiveCall,
  });

  return NextResponse.json({ policy: result }, { status: 201 });
}
