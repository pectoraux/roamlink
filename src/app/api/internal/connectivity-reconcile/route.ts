/**
 * Internal connectivity reconciliation endpoint.
 * Invoked by Vercel Cron (see vercel.json) via GET with Authorization: Bearer ${CRON_SECRET}.
 * Also accepts POST for manual/admin triggering.
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcileConnectivityEntitlements } from "@/lib/connectivity/entitlement";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("cron.secret_not_configured", { message: "CRON_SECRET env var not set — cron endpoint disabled" });
    return false;
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === secret;
}

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runReconciliation();
}

export async function POST(req: NextRequest) {
  if (isCronAuthorized(req)) {
    return runReconciliation();
  }
  try {
    await requireAdmin();
    return runReconciliation();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

async function runReconciliation() {
  const startedAt = Date.now();
  logger.info("cron.connectivity_reconciliation.started", {});

  let result;
  try {
    result = await reconcileConnectivityEntitlements();
  } catch (err) {
    logger.error("cron.connectivity_reconciliation.failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "Reconciliation failed" }, { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  logger.info("cron.connectivity_reconciliation.completed", { durationMs, ...result });

  return NextResponse.json({ ok: true, durationMs, ...result });
}
