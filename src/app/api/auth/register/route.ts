import { NextRequest } from "next/server";
import { joinWaitlist } from "@/lib/auth";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/**
 * Sign-up → joins the WAITLIST (no account created yet).
 * An admin approves + creates the account via /api/admin/waitlist/[id]/approve.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = body?.email;
    const name = body?.name;
    if (!email) throw new AppError("validation", "Missing email", 400, "Please enter your email.");
    const result = await joinWaitlist({ email, name });
    return json({ id: result.id, status: result.status, message: "You're on the waitlist! We'll email you when your account is ready." }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
