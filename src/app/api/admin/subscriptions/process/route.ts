import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { processDueSubscriptions } from "@/lib/subscriptions/service";
import { json, errorResponse } from "@/lib/api";

/** POST /api/admin/subscriptions/process — process due renewals (admin/cron trigger). */
export async function POST() {
  try {
    await requireAdmin();
    const result = await processDueSubscriptions();
    return json({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
