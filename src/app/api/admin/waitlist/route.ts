import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";

/** List waitlist entries (optionally filtered by status). */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status"); // pending | approved | rejected | all
    const where = status && status !== "all" ? { status } : {};
    const entries = await db.waitlistEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return json({ entries });
  } catch (err) {
    return errorResponse(err);
  }
}
