import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserNumber } from "@/lib/virtual-numbers/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/virtual-numbers/[id] — get number details. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const vn = await getUserNumber(user.id, id);
    return json({ number: vn });
  } catch (err) {
    return errorResponse(err);
  }
}
