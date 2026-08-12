import { requireAdmin } from "@/lib/auth";
import { getProviderStatuses } from "@/lib/providers/routing";
import { json, errorResponse } from "@/lib/api";

/** GET /api/admin/providers/health — provider health + credit + reliability. */
export async function GET() {
  try {
    await requireAdmin();
    const statuses = await getProviderStatuses();
    return json({ providers: statuses });
  } catch (err) {
    return errorResponse(err);
  }
}
