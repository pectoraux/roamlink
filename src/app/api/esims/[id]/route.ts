import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const esim = await db.esim.findUnique({
      where: { id },
      include: { order: { include: { plan: true } }, topUps: true },
    });
    if (!esim || esim.userId !== user.id) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");
    return json({ esim });
  } catch (err) {
    return errorResponse(err);
  }
}
