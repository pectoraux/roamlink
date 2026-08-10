import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { purchaseNumber } from "@/lib/virtual-numbers/service";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** POST /api/virtual-numbers/orders — purchase a number. */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const body = await req.json();
    if (!body?.providerNumberId) throw new AppError("validation", "Missing providerNumberId", 400, "Please select a number.");

    const idempotencyKey = body.idempotencyKey ?? generateIdempotencyKey("vn_checkout");
    const result = await purchaseNumber({
      userId: user.id,
      providerNumberId: body.providerNumberId,
      idempotencyKey,
      ip: getClientIP(req),
    });
    return json({ ...result, idempotencyKey }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
