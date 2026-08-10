import { requireAdmin } from "@/lib/auth";
import { providerStatus } from "@/server/services/admin";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    await requireAdmin();
    return json({ providers: providerStatus() });
  } catch (err) {
    return errorResponse(err);
  }
}
