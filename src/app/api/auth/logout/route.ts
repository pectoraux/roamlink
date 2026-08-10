import { NextRequest } from "next/server";
import { logout, clearSessionCookie } from "@/lib/auth";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get("esim_session")?.value;
    if (token) await logout(token);
    await clearSessionCookie();
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
