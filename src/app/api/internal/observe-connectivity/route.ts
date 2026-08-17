/**
 * Phase 8.6.6 — Continuous Connectivity Observation Cron
 * POST /api/internal/observe-connectivity
 *
 * The continuous observation loop that feeds the decision engine. Runs the
 * full closed-loop worker cycle:
 *
 *   1. Reclaim expired decision + event claims (abandoned worker recovery)
 *   2. Re-observe resources with EXPIRED current measurements (never go blind)
 *   3. Probe remaining active sessions (excluding already-probed stale ones)
 *   4. Process pending re-evaluation events → produce Decisions (PENDING)
 *   5. Execute pending non-KEEP Decisions → Actions (fenced — closes the loop)
 *
 * Phase 8.6.6: stale resources probed in step 2 are excluded from step 3 to
 * avoid duplicate provider traffic.
 *
 * Protected by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { probeAllActiveSessions, probeStaleActiveResources } from "@/lib/control-plane/observation";
import { processPendingEvents, reclaimExpiredClaims } from "@/lib/control-plane/reevaluation";
import { executePendingDecisions, reclaimExpiredDecisionClaims } from "@/lib/control-plane/decision-executor";
import { reclaimExpiredSessionSlots } from "@/lib/control-plane/session-execution-slot";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Reclaim expired claims (crashed workers) for events, decisions, and session slots.
  const eventReclaim = await reclaimExpiredClaims();
  const decisionReclaim = await reclaimExpiredDecisionClaims();
  const sessionSlotReclaim = await reclaimExpiredSessionSlots();

  // 2. Re-observe resources with expired/unknown current measurements first
  //    (freshness clock policy — never go blind when connectivity is failing).
  const staleProbe = await probeStaleActiveResources();

  // 3. Probe remaining active sessions, EXCLUDING those already probed in step 2
  //    (Phase 8.6.6: avoid double-probing stale resources in the same cycle).
  const probeResult = await probeAllActiveSessions(staleProbe.probedResourceIds);

  // 4. Process pending re-evaluation events → produce Decisions (PENDING).
  //    The reevaluation worker only DECIDES; it does not execute.
  const eventResult = await processPendingEvents(100);

  // 5. Execute pending non-KEEP Decisions → ConnectivityActions (fenced).
  //    Each decision is claimed atomically before execution.
  const decisionResult = await executePendingDecisions(20);

  logger.info("observation.cron", {
    eventClaimsReclaimed: eventReclaim.reclaimed,
    deadLettered: eventReclaim.deadLettered,
    decisionClaimsReclaimed: decisionReclaim.reclaimed,
    sessionSlotsReclaimed: sessionSlotReclaim.reclaimed,
    staleProbed: staleProbe.probed,
    probed: probeResult.probed,
    eventsProcessed: eventResult.processed,
    decisionsExecuted: decisionResult.executed,
  });

  return NextResponse.json({
    eventClaimsReclaimed: eventReclaim.reclaimed,
    deadLettered: eventReclaim.deadLettered,
    decisionClaimsReclaimed: decisionReclaim.reclaimed,
    sessionSlotsReclaimed: sessionSlotReclaim.reclaimed,
    staleProbed: staleProbe.probed,
    probed: probeResult.probed,
    eventsProcessed: eventResult.processed,
    eventResults: eventResult.results,
    decisionsExecuted: decisionResult.executed,
    decisionResults: decisionResult.results,
  });
}
