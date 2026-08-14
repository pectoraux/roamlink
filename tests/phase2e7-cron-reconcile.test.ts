/**
 * Phase 2E.7.2 — Reconciliation cron endpoint test.
 *
 * Verifies that /api/internal/reconcile:
 *   1. Returns 401 without a CRON_SECRET header (fail closed).
 *   2. Returns 401 with a wrong CRON_SECRET.
 *   3. Returns 200 with the correct CRON_SECRET and runs both workers.
 *   4. The response includes subscription + creditIssuance reconciliation counts.
 *
 * This proves the reconciliation worker is not just a library function but
 * has a production-scheduled invocation path (Vercel Cron via vercel.json).
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/internal/reconcile/route";
import { ensureTestSetup } from "./setup";

let setupDone = false;
async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
}

function makeReq(method: string, headers: Record<string, string> = {}): NextRequest {
  const url = "http://localhost:3000/api/internal/reconcile";
  return new NextRequest(url, { method, headers });
}

describe("Phase 2E.7.2 — Reconciliation cron endpoint", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("GET without Authorization header → 401 (fail closed)", async () => {
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  }, 30000);

  it("GET with wrong Bearer token → 401", async () => {
    const res = await GET(makeReq("GET", { authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
  }, 30000);

  it("GET with correct CRON_SECRET → 200 + runs both workers", async () => {
    const secret = process.env.CRON_SECRET!;
    expect(secret).toBeTruthy(); // must be configured for this test to be meaningful
    const res = await GET(makeReq("GET", { authorization: `Bearer ${secret}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.subscriptions).toBeDefined();
    expect(body.creditIssuances).toBeDefined();
    expect(typeof body.creditIssuances.retried).toBe("number");
    expect(typeof body.creditIssuances.repaired).toBe("number");
  }, 120000);

  it("POST with correct CRON_SECRET → 200 (manual trigger path)", async () => {
    const secret = process.env.CRON_SECRET!;
    const res = await POST(makeReq("POST", { authorization: `Bearer ${secret}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  }, 120000);

  it("POST without auth → 401 (no admin session, no cron secret)", async () => {
    const res = await POST(makeReq("POST"));
    expect(res.status).toBe(401);
  }, 30000);

  it("Static: vercel.json schedules the cron endpoint", async () => {
    const fs = await import("fs");
    const vj = JSON.parse(fs.readFileSync("vercel.json", "utf-8"));
    expect(vj.crons).toBeDefined();
    expect(Array.isArray(vj.crons)).toBe(true);
    expect(vj.crons.length).toBeGreaterThan(0);
    const reconcile = vj.crons.find((c: any) => c.path === "/api/internal/reconcile");
    expect(reconcile).toBeDefined();
    expect(reconcile.schedule).toMatch(/^\*\/\d+ \* \* \* \*$/); // every N minutes
  }, 10000);
});
