import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listTopUpPackages, purchaseTopUp } from "@/lib/usage/topup";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** List available top-up packages. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const packages = await listTopUpPackages(id, user.id);
    return json({ packages });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Purchase a top-up. POST { packageId, idempotencyKey? }. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const body = await req.json();
    if (!body?.packageId) throw new AppError("validation", "Missing packageId", 400, "Please choose a top-up package.");
    const idempotencyKey = body.idempotencyKey ?? generateIdempotencyKey("topup");
    const result = await purchaseTopUp({ esimId: id, userId: user.id, packageId: body.packageId, idempotencyKey, ip: getClientIP(req) });
    return json({ ...result, idempotencyKey }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
