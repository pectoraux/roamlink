import { NextRequest } from "next/server";
import { registerCustomer, setSessionCookie, login } from "@/lib/auth";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = body?.email;
    const password = body?.password;
    const name = body?.name;
    if (!email || !password) throw new AppError("validation", "Missing fields", 400, "Email and password are required.");
    const user = await registerCustomer({ email, password, name });
    const { token } = await login({ email, password, userAgent: req.headers.get("user-agent") ?? undefined, ip: getClientIP(req) });
    await setSessionCookie(token);
    return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
