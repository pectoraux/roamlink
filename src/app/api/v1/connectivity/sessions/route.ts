/**
 * Protocol API — Sessions
 * GET  /api/v1/connectivity/sessions — list sessions for the user (tenant-scoped)
 * POST /api/v1/connectivity/sessions — create a session
 *
 * Phase 12.2 P0-5 (corrected): GET now constrains the tenant AT THE DATABASE
 * QUERY LEVEL via the entitlement relation filter:
 *
 *   WHERE subjectId = user.id
 *     AND entitlement.tenantId = ctx.tenantId
 *     AND entitlement.userId = user.id
 *   ORDER BY createdAt DESC
 *   LIMIT 20
 *
 * The tenant filter is part of the query itself, applied BEFORE `take`. This is
 * the authoritative boundary — there is no post-fetch application-level filtering.
 *
 * The previous implementation fetched 20 rows first, then filtered them by
 * tenant in application code. That was tenant-safe (no cross-tenant leak) but
 * incorrect for pagination/limit semantics: if the newest 20 sessions were
 * predominantly from tenant B, a tenant-A caller would receive fewer than 20
 * valid sessions even when older tenant-A sessions existed. The DB query must
 * constrain the tenant before take.
 *
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

  // Phase 12.2 P0-5 (corrected): Tenant ownership is part of the database query
  // itself, via the entitlement relation. The query is:
  //
  //   WHERE subjectId = user.id
  //     AND entitlement.tenantId = ctx.tenantId
  //     AND entitlement.userId = user.id
  //   ORDER BY createdAt DESC
  //   LIMIT 20
  //
  // Sessions without an entitlement (entitlementId IS NULL) are excluded by
  // the relation filter — they have no tenant authority. The `take: 20` is
  // applied AFTER the tenant filter, so pagination/limit semantics are correct:
  // the caller receives up to 20 of their own tenant-scoped sessions, not
  // "20 of the newest, then filtered" (which could return fewer than 20 even
  // when valid older sessions exist).
  const sessions = await db.connectivitySession.findMany({
    where: {
      subjectId: user.id,
      entitlement: {
        tenantId: ctx.tenantId,
        userId: user.id,
      },
    },
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
