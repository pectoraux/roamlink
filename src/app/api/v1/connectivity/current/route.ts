/**
 * Phase 9.2 — Current Connectivity (read-only)
 * GET /api/v1/connectivity/current
 *
 * Returns a read-only projection of the user's current connectivity state.
 * The mobile UI consumes this to display state — it has NO control-plane
 * authority. The server remains authoritative.
 *
 * Auth-scoped: the endpoint cannot expose another user's resource. It finds
 * sessions where subjectId = authenticated user only.
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getCurrentConnectivityForUser } from "@/lib/control-plane/current-connectivity";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const current = await getCurrentConnectivityForUser(user.id);
  return NextResponse.json(current);
}
