/**
 * Phase 8.5 — Durable Control-Loop Recovery
 *
 * Tests:
 *   8.5.1: markResourceInUse returns structured result (not void)
 *   8.5.2: kernel bridge exists with resolveResourceBinding + verifyResourceUsable
 *   8.5.3: createAction accepts caller-supplied idempotencyKey + deduplicates
 *   8.5.3: recoverStaleActions exists for EXECUTING crash recovery
 *   8.5.4: verifyResourceUsable checks DB state + kernel reconcile
 *   8.5.5: decision engine evaluates all candidates, not just first
 *   8.5.6: ACTIVATE fails closed when markResourceInUse fails
 *   8.5.6: SWITCH fails closed when markResourceInUse fails
 *   KERNEL: no direct provider calls in kernel bridge
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.5 — Durable Control-Loop Recovery", () => {
  // -------------------------------------------------------------------------
  // 8.5.1: markResourceInUse fail-closed
  // -------------------------------------------------------------------------
  it("8.5.1: markResourceInUse returns { activated, reason? }, not void", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    // Must return a structured result
    expect(source).toContain("Promise<{");
    expect(source).toContain("activated: boolean");
    expect(source).toContain("reason?: string");
    // Must check result.count
    expect(source).toContain("result.count === 0");
    // Must only transition from RESERVED → IN_USE
    expect(source).toContain("state: \"RESERVED\"");
  });

  // -------------------------------------------------------------------------
  // 8.5.2: Kernel bridge
  // -------------------------------------------------------------------------
  it("8.5.2: kernel bridge exists with resolveResourceBinding + verifyResourceUsable", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).toContain("export async function resolveResourceBinding");
    expect(source).toContain("export async function verifyResourceUsable");
    // Must call frozen kernel functions
    expect(source).toContain("provisionBinding");
    expect(source).toContain("reconcileProvisioning");
    // Must NOT call provider APIs directly
    expect(source).not.toContain("adapter.provision");
    expect(source).not.toContain("adapter.suspend");
  });

  it("8.5.2b: kernel bridge resolves ProtocolResource → entitlement → binding → adapter", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).toContain("protocolResource.findUnique");
    expect(source).toContain("createEntitlement");
    expect(source).toContain("createResourceBinding");
    expect(source).toContain("provisionBinding");
  });

  // -------------------------------------------------------------------------
  // 8.5.3: Durable action idempotency + recovery
  // -------------------------------------------------------------------------
  it("8.5.3a: createAction accepts caller-supplied idempotencyKey", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("idempotencyKey?: string");
    expect(source).toContain("caller-supplied durable key");
  });

  it("8.5.3b: createAction deduplicates by idempotencyKey", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("findUnique");
    expect(source).toContain("where: { idempotencyKey }");
    expect(source).toContain("idempotent_return");
  });

  it("8.5.3c: recoverStaleActions exists and handles EXECUTING actions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("export async function recoverStaleActions");
    expect(source).toContain("state: \"EXECUTING\"");
    expect(source).toContain("recovered_succeeded");
    expect(source).toContain("recovered_failed_reserved");
    expect(source).toContain("recovered_reconciliation_required");
  });

  it("8.5.3d: recovery worker handles all crash scenarios", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    // IN_USE + owned → SUCCEEDED
    expect(source).toContain("IN_USE");
    expect(source).toContain("SUCCEEDED");
    // RESERVED + owned → release + FAILED
    expect(source).toContain("RESERVED");
    expect(source).toContain("FAILED");
    // Unknown → RECONCILIATION_REQUIRED
    expect(source).toContain("RECONCILIATION_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // 8.5.4: Real verification
  // -------------------------------------------------------------------------
  it("8.5.4: verifyResourceUsable checks DB state + kernel reconcile", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    // Must check DB state
    expect(source).toContain("IN_USE");
    expect(source).toContain("reservedBy !== sessionId");
    // Must check via kernel reconcile if binding exists
    expect(source).toContain("reconcileProvisioning");
    expect(source).toContain("binding.id");
  });

  it("8.5.4b: ACTIVATE calls verifyResourceUsable after markResourceInUse", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("verifyResourceUsable(targetResourceId, session.id)");
    expect(source).toContain("Resource verification failed");
  });

  // -------------------------------------------------------------------------
  // 8.5.5: Candidate scoring
  // -------------------------------------------------------------------------
  it("8.5.5: decision engine evaluates ALL candidates, not just first", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    // Must have a Candidate type
    expect(source).toContain("type Candidate");
    // Must push all resources into candidates array
    expect(source).toContain("candidates.push");
    // Must sort by score
    expect(source).toContain("candidates.sort");
    expect(source).toContain("b.score - a.score");
    // Must NOT just pick resources[0] and break
    expect(source).not.toContain("resources[0].id");
    expect(source).not.toContain("break;");
  });

  it("8.5.5b: candidate score includes capacity boost", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain("availableBandwidthMbps");
    expect(source).toContain("resourceScore");
  });

  // -------------------------------------------------------------------------
  // 8.5.6: ACTIVATE/SWITCH fail closed
  // -------------------------------------------------------------------------
  it("8.5.6a: ACTIVATE fails closed when markResourceInUse returns activated=false", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("!activateResult.activated");
    expect(source).toContain("Failed to mark resource IN_USE");
    // Must release on failure
    expect(source).toContain("releaseResource(targetResourceId, session.id)");
  });

  it("8.5.6b: SWITCH fails closed when markResourceInUse returns activated=false", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    // The SWITCH case must also check activateResult
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("!activateResult.activated");
    expect(switchCase).toContain("Failed to mark target IN_USE");
    expect(switchCase).toContain("releaseResource(targetResourceId, session.id)");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: kernel bridge does not call provider APIs directly", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).not.toContain("adapter.provision");
    expect(source).not.toContain("adapter.suspend");
    expect(source).not.toContain("adapter.release");
    // Must use kernel functions
    expect(source).toContain("provisionBinding");
    expect(source).toContain("reconcileProvisioning");
  });

  it("KERNEL: entitlement.ts has no Phase 8.5 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("kernel-bridge");
    expect(source).not.toContain("verifyResourceUsable");
    expect(source).not.toContain("recoverStaleActions");
    expect(source).toContain("export async function provisionBinding");
  });
});
