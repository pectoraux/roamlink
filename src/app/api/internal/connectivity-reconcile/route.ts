/**
 * Internal connectivity reconciliation endpoint.
 * Invoked by Vercel Cron (see vercel.json) via GET with Authorization: Bearer ${CRON_SECRET}.
 * Also accepts POST for manual/admin triggering.
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcileConnectivityEntitlements } from "@/lib/connectivity/entitlement";
import { recoverStaleProviderOperations, reclaimExpiredRecoveryClaims } from "@/lib/observability/provider-operation-recovery";
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

  // Phase 12.4.4f: Recover stale STARTED ProviderOperationRecords.
  // First reclaim expired recovery claims (crashed recovery workers),
  // then run the recovery worker.
  let recoveryResult;
  try {
    await reclaimExpiredRecoveryClaims();
    recoveryResult = await recoverStaleProviderOperations();
  } catch (err) {
    logger.error("cron.provider_operation_recovery.failed", { error: err instanceof Error ? err.message : String(err) });
    recoveryResult = { examined: 0, claimed: 0, recovered: 0, ambiguous: 0, failed: 0, retained: 0 };
  }

  // Phase 12.4.6.2: Prune old rate limit events.
  let rateLimitPruned = 0;
  try {
    const { pruneRateLimitEvents } = await import("@/lib/api/rate-limit");
    const pruneResult = await pruneRateLimitEvents();
    rateLimitPruned = pruneResult.pruned;
  } catch (err) {
    logger.error("cron.rate_limit_prune.failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const durationMs = Date.now() - startedAt;
  logger.info("cron.connectivity_reconciliation.completed", { durationMs, ...result, recovery: recoveryResult, rateLimitPruned });

  return NextResponse.json({ ok: true, durationMs, ...result, recovery: recoveryResult });
}
