/**
 * POST /api/tenant/switch — switch the active tenant for the current session.
 * Body: { tenantId: string }
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { setActiveTenant } from "@/lib/tenant/context";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const { tenantId } = body;
    if (!tenantId || typeof tenantId !== "string") {
      return json({ error: "tenantId is required" }, 400);
    }
    await setActiveTenant(user.id, tenantId);
    return json({ ok: true, tenantId }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
