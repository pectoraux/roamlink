import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adminSyncPlans } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";

export async function POST(_req: NextRequest) {
  try {
    await requireAdmin();
    const result = await adminSyncPlans();
    return json({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
