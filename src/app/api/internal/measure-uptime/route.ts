/**
 * Phase 7.6 — Uptime Measurement Cron
 * POST /api/internal/measure-uptime
 *
 * Pings all active provider instances and records reachability.
 * Called by a cron job.
 *
 * Protected by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get all active provider instances
  const instances = await db.connectivityProviderInstance.findMany({
    where: { status: "active" },
    select: { id: true, tenantId: true, configuration: true, providerType: true },
  });

  let measured = 0;
  let reachable = 0;

  for (const instance of instances) {
    const config = instance.configuration ? JSON.parse(instance.configuration) : {};
    const endpoint = config.endpoint as string | undefined;

    // Only measure if there's an endpoint to ping
    if (!endpoint) continue;

    const start = Date.now();
    let isReachable = false;
    let responseTimeMs: number | undefined;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(endpoint, {
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
      });

      clearTimeout(timeoutId);
      responseTimeMs = Date.now() - start;
      isReachable = res.ok || res.status === 401 || res.status === 403; // auth errors mean it's reachable
    } catch {
      isReachable = false;
      responseTimeMs = undefined;
    }

    await db.uptimeMeasurement.create({
      data: {
        tenantId: instance.tenantId,
        providerInstanceId: instance.id,
        isReachable,
        responseTimeMs,
      },
    });

    measured++;
    if (isReachable) reachable++;
  }

  logger.info("uptime.measured", { measured, reachable, total: instances.length });

  return NextResponse.json({ measured, reachable, total: instances.length });
}
