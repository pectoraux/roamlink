import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { validatePromoCode } from "@/lib/promotions/promo-service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** POST /api/promo/validate — validate a promo code against an order amount. */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const body = await req.json();
    if (!body?.code) throw new AppError("validation", "Missing code", 400, "Please enter a promo code.");
    const result = await validatePromoCode({
      code: body.code,
      orderAmountMinor: Number(body.orderAmountMinor ?? 0),
      currency: body.currency ?? "USD",
      userId: user.id,
    });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
