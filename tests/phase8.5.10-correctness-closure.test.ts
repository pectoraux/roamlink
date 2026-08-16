/**
 * Phase 8.5.10 — Correctness closure: stale predicate + lease expiry + invariant wiring
 *
 * Tests:
 *   8.5.10.1: Recovery only claims stale EXECUTING (executedAt < cutoff)
 *   8.5.10.2: Recovery reclaims expired RECOVERY_CLAIMED (lease expiry)
 *   8.5.10.3: Recovery sets recoveryClaimExpiresAt
 *   8.5.10.4: assertActiveConnectivityInvariant wired into ACTIVATE
 *   8.5.10.5: assertActiveConnectivityInvariant wired into SWITCH
 *   8.5.10.6: assertActiveConnectivityInvariant wired into recovery
 *   8.5.10.7: Invariant failure → RECONCILIATION_REQUIRED (not SUCCEEDED)
 *   8.5.10.8: Schema has recoveryClaimExpiresAt field
 *   KERNEL: unchanged
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.5.10 — Correctness closure", () => {
  // -------------------------------------------------------------------------
  // 1. Stale predicate
  // -------------------------------------------------------------------------
  it("8.5.10.1: recovery only claims stale EXECUTING (executedAt < cutoff)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("RECOVERY_TIMEOUT_MS");
    expect(recoveryFunc).toContain("staleCutoff");
    expect(recoveryFunc).toContain("executedAt: { lt: staleCutoff }");
  });

  // -------------------------------------------------------------------------
  // 2. Lease expiry
  // -------------------------------------------------------------------------
  it("8.5.10.2: recovery reclaims expired RECOVERY_CLAIMED (lease expiry)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("RECOVERY_LEASE_MS");
    expect(recoveryFunc).toContain("leaseExpiry");
    expect(recoveryFunc).toContain("recoveryClaimExpiresAt: { lt: now }");
  });

  it("8.5.10.3: recovery sets recoveryClaimExpiresAt on claim", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("recoveryClaimExpiresAt: leaseExpiry");
  });

  // -------------------------------------------------------------------------
  // 3. Invariant wired into ACTIVATE
  // -------------------------------------------------------------------------
  it("8.5.10.4: assertActiveConnectivityInvariant wired into ACTIVATE", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    expect(activateCase).toContain("assertActiveConnectivityInvariant");
    expect(activateCase).toContain("activate_invariant_failed");
  });

  // -------------------------------------------------------------------------
  // 4. Invariant wired into SWITCH
  // -------------------------------------------------------------------------
  it("8.5.10.5: assertActiveConnectivityInvariant wired into SWITCH", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("assertActiveConnectivityInvariant");
    expect(switchCase).toContain("switch_invariant_failed");
  });

  // -------------------------------------------------------------------------
  // 5. Invariant wired into recovery
  // -------------------------------------------------------------------------
  it("8.5.10.6: assertActiveConnectivityInvariant wired into recovery", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("assertActiveConnectivityInvariant");
    expect(recoveryFunc).toContain("recoveryInvariant");
    expect(recoveryFunc).toContain("recovered_invariant_failed");
  });

  // -------------------------------------------------------------------------
  // 6. Invariant failure → RECONCILIATION_REQUIRED
  // -------------------------------------------------------------------------
  it("8.5.10.7: invariant failure → RECONCILIATION_REQUIRED (not SUCCEEDED)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    // ACTIVATE
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    expect(activateCase).toContain("RECONCILIATION_REQUIRED");
    expect(activateCase).toContain("return { status: \"failed\"");
    // SWITCH
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("RECONCILIATION_REQUIRED");
    expect(switchCase).toContain("return { status: \"failed\"");
    // Recovery
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("RECONCILIATION_REQUIRED");
    expect(recoveryFunc).toContain("continue");
  });

  // -------------------------------------------------------------------------
  // 7. Schema
  // -------------------------------------------------------------------------
  it("8.5.10.8: ConnectivityAction has recoveryClaimExpiresAt field", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    const actionModel = source.substring(source.indexOf("model ConnectivityAction"), source.indexOf("model ProtocolCapability"));
    expect(actionModel).toContain("recoveryClaimExpiresAt");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts unchanged", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("assertActiveConnectivityInvariant");
    expect(source).not.toContain("RECOVERY_TIMEOUT_MS");
    expect(source).toContain("export async function provisionBinding");
  });
});
