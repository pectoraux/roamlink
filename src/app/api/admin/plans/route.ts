import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { adminUpdatePlanStatus, adminUpdatePlanPrice, providerStatus } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET() {
  try {
    await requireAdmin();
    const plans = await db.plan.findMany({ orderBy: { country: "asc" } });
    return json({ plans });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const { action } = body;
    if (action === "sync") {
      // handled by /api/plans/sync
      throw new AppError("validation", "Use /api/plans/sync", 400);
    }
    throw new AppError("validation", "Unknown action", 400);
  } catch (err) {
    return errorResponse(err);
  }
}
