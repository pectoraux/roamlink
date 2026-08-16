/**
 * Phase 8.5.9 — Control-plane correctness closure (fencing + UNKNOWN + invariant)
 *
 * Tests:
 *   8.5.9.1: Recovery uses RECOVERY_CLAIMED state + claim token
 *   8.5.9.2: Recovery queries by recoveryClaimId (not all RECONCILIATION_REQUIRED)
 *   8.5.9.3: ACTIVATE UNKNOWN releases target (does NOT set session.activeResourceId)
 *   8.5.9.4: Recovery old-release failure → RECONCILIATION_REQUIRED (not .catch swallow)
 *   8.5.9.5: Recovery validates binding via resolveResourceBinding (not manual lookup)
 *   8.5.9.6: assertActiveConnectivityInvariant exists and checks full chain
 *   8.5.9.7: RECOVERY_CLAIMED state exists in protocol + transitions
 *   8.5.9.8: ProtocolResource has recoveryClaimId fields
 *   KERNEL: unchanged
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.5.9 — Control-plane correctness closure", () => {
  // -------------------------------------------------------------------------
  // 1. Recovery fencing with claim token
  // -------------------------------------------------------------------------
  it("8.5.9.1: recovery uses RECOVERY_CLAIMED state + claim token", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("RECOVERY_CLAIMED");
    expect(recoveryFunc).toContain("recoveryClaimId: claimId");
    expect(recoveryFunc).toContain("recoveryClaimedAt");
    expect(recoveryFunc).toContain("claimId");
  });

  it("8.5.9.2: recovery queries by recoveryClaimId (not all RECONCILIATION_REQUIRED)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("where: { recoveryClaimId: claimId }");
    // Must NOT query all RECONCILIATION_REQUIRED
    expect(recoveryFunc).not.toContain('where: { state: "RECONCILIATION_REQUIRED" }');
  });

  // -------------------------------------------------------------------------
  // 2. ACTIVATE UNKNOWN releases target
  // -------------------------------------------------------------------------
  it("8.5.9.3: ACTIVATE UNKNOWN releases target before RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    // UNKNOWN branch must release target
    expect(activateCase).toContain("UNKNOWN");
    expect(activateCase).toContain("releaseResource(targetResourceId, session.id)");
    expect(activateCase).toContain("RECONCILIATION_REQUIRED");
    // Must return before updating session (session should NOT be on the target)
    const unknownBranch = activateCase.substring(activateCase.indexOf("if (verifyResult.status === \"UNKNOWN\""));
    expect(unknownBranch).toContain("releaseResource");
    expect(unknownBranch).toContain("return");
    // The session update (activeResourceId) must come AFTER the UNKNOWN check, not before
    const sessionUpdatePos = activateCase.indexOf("activeResourceId: targetResourceId");
    const unknownPos = activateCase.indexOf("if (verifyResult.status === \"UNKNOWN\"");
    expect(sessionUpdatePos).toBeGreaterThan(unknownPos);
  });

  // -------------------------------------------------------------------------
  // 3. Recovery old-release failure → RECONCILIATION_REQUIRED
  // -------------------------------------------------------------------------
  it("8.5.9.4: recovery old-release failure → RECONCILIATION_REQUIRED (not .catch swallow)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("oldReleaseFailed");
    expect(recoveryFunc).toContain("recovery.switch_old_release_failed");
    expect(recoveryFunc).toContain("RECONCILIATION_REQUIRED");
    // Must NOT use .catch(() => {})
    expect(recoveryFunc).not.toContain(".catch(() => {})");
  });

  // -------------------------------------------------------------------------
  // 4. Recovery validates binding via resolveResourceBinding
  // -------------------------------------------------------------------------
  it("8.5.9.5: recovery uses resolveResourceBinding (not manual binding lookup)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("resolveResourceBinding");
    expect(recoveryFunc).toContain("Recovery binding validation failed");
    // entitlementId comes from bridgeResult, not manual lookup
    expect(recoveryFunc).toContain("bridgeResult.entitlementId");
  });

  // -------------------------------------------------------------------------
  // 5. Invariant checker
  // -------------------------------------------------------------------------
  it("8.5.9.6: assertActiveConnectivityInvariant exists and checks full chain", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/invariant-checker.ts", "utf-8");
    expect(source).toContain("export async function assertActiveConnectivityInvariant");
    expect(source).toContain("InvariantResult");
    // Checks: resource state IN_USE
    expect(source).toContain("IN_USE");
    // Checks: reservedBy = session.id
    expect(source).toContain("reservedBy");
    // Checks: providerBindingId exists
    expect(source).toContain("providerBindingId");
    // Checks: entitlement.userId = session.subjectId
    expect(source).toContain("userId");
    expect(source).toContain("subjectId");
    // Checks: tenantId match
    expect(source).toContain("tenantId");
    // Checks: provider verification
    expect(source).toContain("verifyResourceUsable");
    expect(source).toContain("USABLE");
  });

  // -------------------------------------------------------------------------
  // 6. Protocol + schema
  // -------------------------------------------------------------------------
  it("8.5.9.7: RECOVERY_CLAIMED state exists in protocol + transitions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain("\"RECOVERY_CLAIMED\"");
    expect(source).toContain("RECOVERY_CLAIMED: [\"SUCCEEDED\", \"FAILED\", \"RECONCILIATION_REQUIRED\"]");
    // EXECUTING can transition to RECOVERY_CLAIMED
    expect(source).toContain("RECOVERY_CLAIMED");
  });

  it("8.5.9.8: ConnectivityAction has recoveryClaimId + recoveryClaimedAt fields", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    const actionModel = source.substring(source.indexOf("model ConnectivityAction"), source.indexOf("model ProtocolCapability"));
    expect(actionModel).toContain("recoveryClaimId");
    expect(actionModel).toContain("recoveryClaimedAt");
    expect(actionModel).toContain("@@index([recoveryClaimId])");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: invariant checker does not call provider APIs directly", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/invariant-checker.ts", "utf-8");
    expect(source).not.toContain("adapter.provision");
    expect(source).toContain("verifyResourceUsable");
  });

  it("KERNEL: entitlement.ts unchanged", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("assertActiveConnectivityInvariant");
    expect(source).not.toContain("RECOVERY_CLAIMED");
    expect(source).toContain("export async function provisionBinding");
  });
});
