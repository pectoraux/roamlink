import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getAdminStats, adminListOrders, adminListESIMs, adminListUsers, adminUpdatePlanStatus, adminUpdatePlanPrice, adminSyncPlans, providerStatus } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  try {
    await requireAdmin();
    const stats = await getAdminStats();
    return json({ stats });
  } catch (err) {
    return errorResponse(err);
  }
}
