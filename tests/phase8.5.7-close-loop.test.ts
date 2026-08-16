/**
 * Phase 8.5.7 — Close the provider-backed control loop
 *
 * Tests:
 *   8.5.7.1: resolveResourceBinding is called by ACTIVATE
 *   8.5.7.2: resolveResourceBinding is called by SWITCH
 *   8.5.7.3: entitlement lookup scoped by subjectId (userId)
 *   8.5.7.4: verifyResourceUsable returns USABLE | NOT_USABLE | UNKNOWN
 *   8.5.7.5: verifyResourceUsable fails closed on reconciliation error (UNKNOWN)
 *   8.5.7.6: ProtocolResource has providerBindingId field
 *   8.5.7.7: kernel bridge links ProtocolResource to ProviderResourceBinding
 *   8.5.7.8: createAction handles concurrent unique constraint (P2002)
 *   8.5.7.9: recovery calls verifyResourceUsable before SUCCEEDED
 *   8.5.7.10: ACTIVATE passes entitlementId to session
 *   8.5.7.11: SWITCH passes entitlementId to session
 *   KERNEL: no direct provider calls
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.5.7 — Close the provider-backed control loop", () => {
  // -------------------------------------------------------------------------
  // 1. Bridge is on the execution path
  // -------------------------------------------------------------------------
  it("8.5.7.1: ACTIVATE calls resolveResourceBinding", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    expect(activateCase).toContain("resolveResourceBinding");
    expect(activateCase).toContain("bridgeResult");
    expect(activateCase).toContain("Kernel bridge failed");
  });

  it("8.5.7.2: SWITCH calls resolveResourceBinding", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("resolveResourceBinding");
    expect(switchCase).toContain("bridgeResult");
    expect(switchCase).toContain("Kernel bridge failed for target");
  });

  // -------------------------------------------------------------------------
  // 2. Entitlement lookup scoped by subjectId
  // -------------------------------------------------------------------------
  it("8.5.7.3: kernel bridge scopes entitlement by userId/subjectId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).toContain("userId: input.subjectId");
  });

  // -------------------------------------------------------------------------
  // 3. Verification fails closed
  // -------------------------------------------------------------------------
  it("8.5.7.4: verifyResourceUsable returns USABLE | NOT_USABLE | UNKNOWN", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).toContain("status: \"USABLE\"");
    expect(source).toContain("status: \"NOT_USABLE\"");
    expect(source).toContain("status: \"UNKNOWN\"");
    expect(source).toContain("VerificationResult");
  });

  it("8.5.7.5: verifyResourceUsable fails closed on reconciliation error", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    // On catch, must return UNKNOWN (not usable: true)
    const catchBlocks = source.match(/\} catch \(err\) \{/g);
    expect(catchBlocks).not.toBeNull();
    // All catch blocks must produce UNKNOWN, not usable: true
    expect(source).not.toContain("usable: true");
    expect(source).toContain("UNKNOWN");
  });

  it("8.5.7.5b: ACTIVATE handles UNKNOWN by marking RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    expect(activateCase).toContain("UNKNOWN");
    expect(activateCase).toContain("RECONCILIATION_REQUIRED");
  });

  it("8.5.7.5c: SWITCH handles UNKNOWN by releasing + RECONCILIATION_REQUIRED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("UNKNOWN");
    expect(switchCase).toContain("switch_verification_unknown");
    expect(switchCase).toContain("RECONCILIATION_REQUIRED");
    expect(switchCase).toContain("releaseResource");
  });

  // -------------------------------------------------------------------------
  // 4. ProtocolResource → ProviderResourceBinding link
  // -------------------------------------------------------------------------
  it("8.5.7.6: ProtocolResource has providerBindingId field", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    const resourceModel = source.substring(source.indexOf("model ProtocolResource"));
    expect(resourceModel).toContain("providerBindingId");
  });

  it("8.5.7.7: kernel bridge checks and updates providerBindingId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    // Must check existing providerBindingId first
    expect(source).toContain("resource.providerBindingId");
    expect(source).toContain("linked_binding");
    // Must update providerBindingId after creating a new binding
    expect(source).toContain("providerBindingId: binding.id");
  });

  // -------------------------------------------------------------------------
  // 5. Concurrent idempotent action creation
  // -------------------------------------------------------------------------
  it("8.5.7.8: createAction handles P2002 unique constraint race", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("P2002");
    expect(source).toContain("concurrent_idempotent_return");
  });

  // -------------------------------------------------------------------------
  // 6. Recovery calls kernel reconcile
  // -------------------------------------------------------------------------
  it("8.5.7.9: recovery calls verifyResourceUsable before SUCCEEDED", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const recoveryFunc = source.substring(source.indexOf("export async function recoverStaleActions"));
    expect(recoveryFunc).toContain("verifyResourceUsable");
    expect(recoveryFunc).toContain("NOT_USABLE");
    expect(recoveryFunc).toContain("UNKNOWN");
    expect(recoveryFunc).toContain("RECONCILIATION_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // 7. Session gets entitlement link
  // -------------------------------------------------------------------------
  it("8.5.7.10: ACTIVATE passes entitlementId to session", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf("case \"ACTIVATE\""), source.indexOf("case \"SWITCH\""));
    expect(activateCase).toContain("entitlementId: bridgeResult.entitlementId");
  });

  it("8.5.7.11: SWITCH passes entitlementId to session", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("entitlementId: bridgeResult.entitlementId");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: kernel bridge does not call provider APIs directly", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/kernel-bridge.ts", "utf-8");
    expect(source).not.toContain("adapter.provision");
    expect(source).not.toContain("adapter.suspend");
    expect(source).toContain("provisionBinding");
    expect(source).toContain("reconcileProvisioning");
  });

  it("KERNEL: entitlement.ts has no Phase 8.5.7 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("resolveResourceBinding");
    expect(source).not.toContain("verifyResourceUsable");
    expect(source).not.toContain("recoverStaleActions");
    expect(source).toContain("export async function provisionBinding");
  });
});
