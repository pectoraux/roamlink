import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getOrCreateReferral, getCreditBalance, getCreditHistory } from "@/lib/promotions/referral-service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/referral — get the user's referral code + credit balance. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const [referral, credit, history] = await Promise.all([
      getOrCreateReferral(user.id),
      getCreditBalance(user.id),
      getCreditHistory(user.id),
    ]);
    return json({ referral, credit, history });
  } catch (err) {
    return errorResponse(err);
  }
}
