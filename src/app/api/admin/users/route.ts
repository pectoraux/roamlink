import { requireAdmin } from "@/lib/auth";
import { adminListUsers } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    await requireAdmin();
    const users = await adminListUsers();
    return json({ users });
  } catch (err) {
    return errorResponse(err);
  }
}
