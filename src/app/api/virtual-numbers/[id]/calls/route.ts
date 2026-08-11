import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getCalls } from "@/lib/virtual-numbers/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/virtual-numbers/[id]/calls — list calls. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const calls = await getCalls(user.id, id);
    return json({ calls });
  } catch (err) {
    return errorResponse(err);
  }
}
