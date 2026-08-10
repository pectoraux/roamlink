import { NextRequest } from "next/server";
import { login, setSessionCookie } from "@/lib/auth";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body?.email || !body?.password) throw new AppError("validation", "Missing fields", 400, "Email and password are required.");
    const { user, token } = await login({
      email: body.email,
      password: body.password,
      userAgent: req.headers.get("user-agent") ?? undefined,
      ip: getClientIP(req),
    });
    await setSessionCookie(token);
    return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    return errorResponse(err);
  }
}