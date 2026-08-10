/**
 * API route helpers — consistent JSON responses + error handling.
 */

import { NextResponse } from "next/server";
import { AppError, safeErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function errorResponse(err: unknown, status?: number) {
  if (err instanceof AppError) {
    return NextResponse.json({ error: safeErrorMessage(err), code: err.errorClass }, { status: status ?? err.statusCode });
  }
  logger.error("api.unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  return NextResponse.json({ error: "Something went wrong. Please try again.", code: "internal" }, { status: status ?? 500 });
}

export function getClientIP(req: Request): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() ?? undefined;
}
