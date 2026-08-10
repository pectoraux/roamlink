import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const esims = await db.esim.findMany({
      where: { userId: user.id },
      include: { order: { include: { plan: true } } },
      orderBy: { createdAt: "desc" },
    });
    return json({ esims });
  } catch (err) {
    return errorResponse(err);
  }
}
