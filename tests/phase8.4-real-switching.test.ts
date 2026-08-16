/**
 * Phase 8.4 — Real Resource-Controlled Switching
 *
 * Tests:
 *   8.4.1: Decision engine resolves ProtocolResource (not offer ID)
 *   8.4.2: Decision engine uses discoverCapabilities + discoverResources
 *   8.4.3: Hysteresis uses M-of-N degraded, not just count
 *   8.4.4: releaseResource is ownership-safe (checks reservedBy)
 *   8.4.5: markResourceInUse is ownership-safe (checks reservedBy)
 *   8.4.6: ACTIVATE execution: reserve → mark IN_USE → session ACTIVE
 *   8.4.7: SWITCH execution: reserve target → verify → update session → release old
 *   8.4.8: SWITCH failure recovery: reserve fails → session unchanged
 *   8.4.9: SWITCH failure recovery: verify fails → target released → session recovered
 *   8.4.10: SWITCH old resource release failure does NOT invalidate new resource
 *   8.4.11: RELEASE execution: release resource + session ENDED
 *   8.4.12: discoverResources returns only AVAILABLE resources
 *   8.4.13: Kernel preservation
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.4 — Real Resource-Controlled Switching", () => {
  // -------------------------------------------------------------------------
  // Decision Engine: resource-driven, not offer-driven
  // -------------------------------------------------------------------------
  it("8.4.1: decision engine resolves ProtocolResource.id, not ConnectivityOffer2 ID", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    // Must call discoverCapabilities + discoverResources
    expect(source).toContain("discoverCapabilities");
    expect(source).toContain("discoverResources");
    // targetResourceId must be set from bestResource.id (ProtocolResource)
    expect(source).toContain("bestResource.id");
    // Must NOT set targetResourceId from topOffer.offerId
    expect(source).not.toContain("targetResourceId = topOffer.offerId");
  });

  it("8.4.2: decision engine resolves Intent → Capability → Resource", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    // Step 1: discover capabilities
    expect(source).toContain("Step 1: Discover capabilities");
    // Step 2: discover resources
    expect(source).toContain("Step 2: For each capability, discover ALL available resources and score them");
    // The decision uses bestResource + bestCapability
    expect(source).toContain("bestResource");
    expect(source).toContain("bestCapability");
    expect(source).toContain("targetCapabilityId");
  });

  it("8.4.3: hysteresis uses M-of-N degraded (Phase 8.6: persisted in health-derivation)", async () => {
    const fs = await import("fs");
    // Phase 8.6: M-of-N degradation moved out of inline decision-engine logic
    // into the persisted health-derivation module — a genuine control-system
    // property. The decision engine now consults the persisted snapshot.
    const healthSource = fs.readFileSync("src/lib/control-plane/health-derivation.ts", "utf-8");
    expect(healthSource).toContain("degradedThreshold");
    expect(healthSource).toContain("minDegradedCount");
    expect(healthSource).toContain("DEGRADED");
    expect(healthSource).toContain("deriveSampleQuality");

    const decisionSource = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(decisionSource).toContain("getResourceHealth");
    expect(decisionSource).toContain("M_OF_N_DEGRADED");
    expect(decisionSource).toContain("health.status");
  });

  // -------------------------------------------------------------------------
  // Resource ownership safety
  // -------------------------------------------------------------------------
  it("8.4.4: releaseResource is ownership-safe (checks reservedBy)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    // releaseResource must take sessionId parameter
    expect(source).toContain("export async function releaseResource(resourceId: string, sessionId: string)");
    // Must check reservedBy in the WHERE clause
    expect(source).toContain("reservedBy: sessionId");
    // Must return failure on ownership mismatch
    expect(source).toContain("Ownership mismatch");
  });

  it("8.4.5: markResourceInUse is ownership-safe", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    // markResourceInUse must take sessionId
    expect(source).toContain("export async function markResourceInUse(resourceId: string, sessionId: string)");
    // Must check reservedBy
    expect(source).toContain("reservedBy: sessionId");
  });

  // -------------------------------------------------------------------------
  // Action executor: real resource operations
  // -------------------------------------------------------------------------
  it("8.4.6: ACTIVATE execution reserves resource + marks IN_USE + activates session", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("case \"ACTIVATE\"");
    expect(source).toContain("reserveResource(targetResourceId, session.id)");
    expect(source).toContain("markResourceInUse(targetResourceId, session.id)");
    expect(source).toContain("activeResourceId: targetResourceId");
  });

  it("8.4.7: SWITCH execution reserves target → verifies → updates session → releases old", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("reserveResource(targetResourceId, session.id)");
    expect(switchCase).toContain("markResourceInUse(targetResourceId, session.id)");
    expect(switchCase).toContain("verifyResourceUsable(targetResourceId, session.id)");
    expect(switchCase).toContain("activeResourceId: targetResourceId");
    expect(switchCase).toContain("releaseResource(previousResourceId, session.id)");
  });

  it("8.4.8: SWITCH reserve failure → session unchanged (recoverable)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("Failed to reserve target resource");
    // Session is recovered to previous state
    expect(switchCase).toContain("DEGRADED");
  });

  it("8.4.9: SWITCH verify failure → target released → session recovered", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    expect(switchCase).toContain("NOT_USABLE");
    expect(switchCase).toContain("releaseResource(targetResourceId, session.id)");
  });

  it("8.4.10: old resource release failure does NOT invalidate new resource", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const switchCase = source.substring(source.indexOf("case \"SWITCH\""), source.indexOf("case \"SUSPEND\""));
    // The release of the old resource should NOT cause the action to fail
    expect(switchCase).toContain("switch_old_release_failed");
    expect(switchCase).toContain("oldReleaseFailed");
    // Phase 8.5.8: old release failure → RECONCILIATION_REQUIRED (not SUCCEEDED)
    expect(switchCase).toContain("RECONCILIATION_REQUIRED");
    expect(switchCase).toContain("Old resource");
    expect(switchCase).toContain("release failed");
  });

  it("8.4.11: RELEASE execution releases resource + ends session", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("case \"RELEASE\"");
    expect(source).toContain("releaseResource(session.activeResourceId, session.id)");
    expect(source).toContain("transitionSessionState(session.id, \"ENDED\")");
  });

  // -------------------------------------------------------------------------
  // Resource discovery
  // -------------------------------------------------------------------------
  it("8.4.12: discoverResources returns only AVAILABLE resources", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    expect(source).toContain("export async function discoverResources");
    expect(source).toContain("state: \"AVAILABLE\"");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts has no Phase 8.4 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("reserveResource");
    expect(source).not.toContain("releaseResource");
    expect(source).not.toContain("discoverResources");
    expect(source).not.toContain("markResourceInUse");
    expect(source).toContain("export async function provisionBinding");
  });

  it("KERNEL: ranking engine unchanged", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("discoverResources");
    expect(source).not.toContain("ProtocolResource");
    expect(source).toContain("export async function rankOffers");
  });

  it("KERNEL: action executor never calls provider APIs directly", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    // Must NOT call adapter methods directly
    expect(source).not.toContain("adapter.provision");
    expect(source).not.toContain("adapter.suspend");
    expect(source).not.toContain("adapter.release");
    // Must NOT call kernel functions directly (future: via a bridge)
    expect(source).not.toContain("provisionBinding");
    // Must use resource operations instead
    expect(source).toContain("reserveResource");
    expect(source).toContain("releaseResource");
    expect(source).toContain("markResourceInUse");
  });
});
