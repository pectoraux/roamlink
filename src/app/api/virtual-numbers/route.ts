import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserNumbers, getUserNumber, releaseNumber } from "@/lib/virtual-numbers/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/virtual-numbers — list user's numbers. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return json({ numbers: [] });
    const numbers = await listUserNumbers(user.id);
    return json({ numbers });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/virtual-numbers/[id] — get a single number. */
export async function GET_one(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
