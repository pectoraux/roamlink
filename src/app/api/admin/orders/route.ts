import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adminListOrders } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const orders = await adminListOrders({
      search: searchParams.get("search") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : 50,
    });
    return json({ orders });
  } catch (err) {
    return errorResponse(err);
  }
}
