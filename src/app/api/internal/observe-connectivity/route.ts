/**
 * Phase 8.6 — Continuous Connectivity Observation Cron
 * POST /api/internal/observe-connectivity
 *
 * Probes all active sessions via their provider adapters (getUsage), ingests
 * the results as measurements (source=ADAPTER), derives persisted health, and
 * processes any pending re-evaluation events. This is the continuous
 * observation loop that feeds the decision engine.
 *
 * Protected by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { probeAllActiveSessions } from "@/lib/control-plane/observation";
import { processPendingEvents } from "@/lib/control-plane/reevaluation";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Probe all active sessions → ingest measurements → derive health →
  //    emit re-evaluation events (synchronous processing happens inline
  //    during ingestion, but batch-drain any remaining events too).
  const probeResult = await probeAllActiveSessions();

  // 2. Drain any unprocessed re-evaluation events (e.g. from concurrent
  //    ingestions that deferred processing).
  const eventResult = await processPendingEvents(100);

  logger.info("observation.cron", {
    probed: probeResult.probed,
    eventsProcessed: eventResult.processed,
  });

  return NextResponse.json({
    probed: probeResult.probed,
    probeResults: probeResult.results.map((r) => ({
      resourceId: r.resourceId,
      probed: r.probed,
      freshness: r.freshness,
      healthStatus: r.healthStatus,
      reason: r.reason,
    })),
    eventsProcessed: eventResult.processed,
    eventResults: eventResult.results,
  });
}
