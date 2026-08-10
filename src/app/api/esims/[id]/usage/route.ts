import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { syncUsage, simulateUsage, getUsageHistory } from "@/lib/usage/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const esim = await db.esim.findUnique({ where: { id } });
    if (!esim || esim.userId !== user.id) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");
    const history = await getUsageHistory(id);
    return json({ esim: { id: esim.id, dataAmount: esim.dataAmount, dataRemaining: esim.dataRemaining, status: esim.status }, history });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Simulate data usage (dev). POST { usedMB }. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const esim = await db.esim.findUnique({ where: { id } });
    if (!esim || esim.userId !== user.id) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");
    const body = await req.json();
    const usedMB = Number(body?.usedMB ?? 500);
    const result = await simulateUsage(id, usedMB);
    return json({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
