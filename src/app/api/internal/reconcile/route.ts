/**
 * Internal reconciliation cron endpoint.
 *
 * Phase 2E.7.2: Production scheduler for background reconciliation workers.
 *
 * Invoked by Vercel Cron (see vercel.json) every 5 minutes via GET with:
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * Also accepts POST for manual/admin triggering (requires admin session).
 *
 * Runs:
 *   1. processDueSubscriptions() — durable renewal-cycle recovery
 *   2. processDueCreditIssuances() — credit-issuance ledger recovery
 *      (reconciliation_required + stale-pending backstop)
 *
 * Security: Vercel Cron injects CRON_SECRET as a Bearer token. We validate
 * it before running any work. This prevents public abuse of the endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { processDueSubscriptions } from "@/lib/subscriptions/service";
import { processDueCreditIssuances } from "@/lib/promotions/referral-service";
import { processDueDepositReconciliation, processDueResellerReservationReconciliation } from "@/lib/tenant/balance";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

/** Validate the CRON_SECRET bearer token (Vercel Cron pattern). */
function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If no secret is configured, deny all cron requests (fail closed).
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
  // POST is for manual/admin triggering — requires either CRON_SECRET or admin session.
  if (isCronAuthorized(req)) {
    return runReconciliation();
  }
  try {
    await requireAdmin();
    return runReconciliation();
  } catch (err) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

async function runReconciliation() {
  const startedAt = Date.now();
  logger.info("cron.reconciliation.started", {});

  let subscriptions: { renewed: number; failed: number; suspended: number; cancelled: number; reconciled: number };
  let creditIssuances: { retried: number; repaired: number; stillFailing: number };

  try {
    subscriptions = await processDueSubscriptions();
  } catch (err) {
    logger.error("cron.reconciliation.subscriptions_failed", { error: err instanceof Error ? err.message : String(err) });
    subscriptions = { renewed: 0, failed: 0, suspended: 0, cancelled: 0, reconciled: 0 };
  }

  try {
    creditIssuances = await processDueCreditIssuances();
  } catch (err) {
    logger.error("cron.reconciliation.credit_issuances_failed", { error: err instanceof Error ? err.message : String(err) });
    creditIssuances = { retried: 0, repaired: 0, stillFailing: 0 };
  }

  let deposits: { retried: number; repaired: number; stillFailing: number };
  try {
    deposits = await processDueDepositReconciliation();
  } catch (err) {
    logger.error("cron.reconciliation.deposits_failed", { error: err instanceof Error ? err.message : String(err) });
    deposits = { retried: 0, repaired: 0, stillFailing: 0 };
  }

  let reservations: { retried: number; repaired: number; stillFailing: number };
  try {
    reservations = await processDueResellerReservationReconciliation();
  } catch (err) {
    logger.error("cron.reconciliation.reservations_failed", { error: err instanceof Error ? err.message : String(err) });
    reservations = { retried: 0, repaired: 0, stillFailing: 0 };
  }

  const durationMs = Date.now() - startedAt;
  logger.info("cron.reconciliation.completed", { durationMs, subscriptions, creditIssuances, deposits, reservations });

  return NextResponse.json({
    ok: true,
    durationMs,
    subscriptions,
    creditIssuances,
    deposits,
    reservations,
  });
}
