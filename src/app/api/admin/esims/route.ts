import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adminListESIMs } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const esims = await adminListESIMs({
      search: searchParams.get("search") ?? undefined,
      status: searchParams.get("status") ?? undefined,
    });
    return json({ esims });
  } catch (err) {
    return errorResponse(err);
  }
}
