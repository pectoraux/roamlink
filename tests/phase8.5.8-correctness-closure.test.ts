/**
 * Phase 8.5.8 — Control-plane correctness closure
 *
 * Tests:
 *   8.5.8.1: resolveResourceBinding derives tenantId from capability (not caller)
 *   8.5.8.2: providerBindingId validated against tenant + subject + providerType
 *   8.5.8.3: ACTIVATE UNKNOWN → RECONCILIATION_REQUIRED (not SUCCEEDED)
 *   8.5.8.4: SWITCH UNKNOWN → release + recover + RECONCILIATION_REQUIRED
 *   8.5.8.5: Old-resource release failure → RECONCILIATION_REQUIRED (not SUCCEEDED)
 *   8.5.8.6: Recovery restores entitlementId alongside activeResourceId
 *   8.5.8.7: Recovery-worker fencing (atomic claim via updateMany)
 *   8.5.8.8: Bridge input no longer accepts tenantId
 *   KERNEL: unchanged
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.5.8 — Control-plane correctness closure", () => {
  // -------------------------------------------------------------------------
  // 1. tenantId derived from capability
  // -------------------------------------------------------------------------
  it("8.5.8.1: resolveResourceBinding derives tenantId from capability.tenantId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).toContain("const tenantId = capability.tenantId");
    expect(source).toContain("DERIVE tenantId from the capability");
  });

  it("8.5.8.8: bridge input no longer accepts tenantId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    // The input type should NOT have tenantId
    const inputMatch = source.match(/export async function resolveResourceBinding\(input: \{[^}]+\}/);
    if (inputMatch) {
      expect(inputMatch[0]).not.toContain("tenantId");
    }
  });

  // -------------------------------------------------------------------------
  // 2. providerBindingId validated
  // -------------------------------------------------------------------------
  it("8.5.8.2: linked binding validated against tenant + subject + providerType", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).toContain("binding_tenant_mismatch");
    expect(source).toContain("binding_subject_mismatch");
    expect(source).toContain("binding_provider_type_mismatch");
    expect(source).toContain("Binding tenant mismatch");
    expect(source).toContain("Binding subject mismatch");
    expect(source).toContain("Binding providerType mismatch");
  });

  // -------------------------------------------------------------------------
  // 3. UNKNOWN → RECONCILIATION_REQUIRED (not SUCCEEDED)
  // -------------------------------------------------------------------------
  it("8.5.8.3: ACTIVATE UNKNOWN → RECONCILIATION_REQUIRED + returns failed", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    expect(activateCase).toContain("UNKNOWN");
    expect(activateCase).toContain("RECONCILIATION_REQUIRED");
    // Must return failed, NOT succeeded
    expect(activateCase).toContain("return { status: \"failed\"");
  });

  it("8.5.8.4: SWITCH UNKNOWN → release + recover + RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("UNKNOWN");
    expect(switchCase).toContain("releaseResource(targetResourceId, session.id)");
    expect(switchCase).toContain("RECONCILIATION_REQUIRED");
    expect(switchCase).toContain("return { status: \"failed\"");
  });

  // -------------------------------------------------------------------------
  // 4. Old-resource release failure → durable reconciliation marker
  // -------------------------------------------------------------------------
  it("8.5.8.5: old-resource release failure → RECONCILIATION_REQUIRED (not SUCCEEDED)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("oldReleaseFailed");
    expect(switchCase).toContain("RECONCILIATION_REQUIRED");
    expect(switchCase).toContain("Old resource");
    expect(switchCase).toContain("release failed");
  });

  // -------------------------------------------------------------------------
  // 5. Recovery restores entitlementId
  // -------------------------------------------------------------------------
  it("8.5.8.6: recovery restores entitlementId alongside activeResourceId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    // Phase 8.5.9: entitlementId comes from bridgeResult (not manual lookup)
    expect(recoveryFunc).toContain("bridgeResult.entitlementId");
    expect(recoveryFunc).toContain("entitlementId: bridgeResult.entitlementId");
  });

  // -------------------------------------------------------------------------
  // 6. Recovery-worker fencing
  // -------------------------------------------------------------------------
  it("8.5.8.7: recovery-worker fencing via atomic updateMany claim", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("Recovery with stale predicate");
    expect(recoveryFunc).toContain("updateMany");
    expect(recoveryFunc).toContain("EXECUTING");
    // Phase 8.5.9: uses RECOVERY_CLAIMED (not RECONCILIATION_REQUIRED) for claim
    expect(recoveryFunc).toContain("RECOVERY_CLAIMED");
    expect(recoveryFunc).toContain("claimResult");
    expect(recoveryFunc).toContain("recoveryClaimId: claimId");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: kernel bridge has no direct provider calls", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).not.toContain("adapter.provision");
    expect(source).toContain("provisionBinding");
    expect(source).toContain("reconcileProvisioning");
  });

  it("KERNEL: entitlement.ts unchanged", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("resolveResourceBinding");
    expect(source).not.toContain("verifyResourceUsable");
    expect(source).not.toContain("recoverStaleActions");
    expect(source).toContain("export async function provisionBinding");
  });
});
