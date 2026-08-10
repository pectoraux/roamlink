import { NextRequest } from "next/server";
import { initiatePayment } from "@/lib/orders/service";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { getCurrentUser } from "@/lib/auth";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** Initiate a payment intent for an order. */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const body = await req.json();
    if (!body?.orderId) throw new AppError("validation", "Missing orderId", 400, "Order id is required.");
    const idempotencyKey = body.idempotencyKey ?? generateIdempotencyKey("payment");
    const result = await initiatePayment({ orderId: body.orderId, userId: user.id, idempotencyKey, ip: getClientIP(req) });
    return json({ ...result, idempotencyKey });
  } catch (err) {
    return errorResponse(err);
  }
}
