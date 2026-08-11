import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { cancelSubscription } from "@/lib/subscriptions/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** POST /api/subscriptions/[id]/cancel — cancel a subscription. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    await cancelSubscription(user.id, id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
