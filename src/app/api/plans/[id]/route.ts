import { NextRequest } from "next/server";
import { getPublicPlan } from "@/lib/plans/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const plan = await getPublicPlan(id);
    if (!plan) throw new AppError("not_found", "Plan not found", 404, "This plan is no longer available.");
    return json({ plan });
  } catch (err) {
    return errorResponse(err);
  }
}
