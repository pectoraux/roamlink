import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adminUpdatePlanStatus, adminUpdatePlanPrice } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json();
    if (body.status) {
      const plan = await adminUpdatePlanStatus(id, body.status as "active" | "inactive");
      return json({ plan });
    }
    if (body.priceMinor != null) {
      const plan = await adminUpdatePlanPrice(id, Number(body.priceMinor));
      return json({ plan });
    }
    throw new AppError("validation", "Nothing to update", 400);
  } catch (err) {
    return errorResponse(err);
  }
}
