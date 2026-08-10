import { NextRequest } from "next/server";
import { getOrder } from "@/lib/orders/service";
import { getCurrentUser } from "@/lib/auth";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const order = await getOrder(id, user.id);
    return json({ order });
  } catch (err) {
    return errorResponse(err);
  }
}
