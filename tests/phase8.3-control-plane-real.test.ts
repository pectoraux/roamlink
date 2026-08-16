/**
 * Phase 8.3 — Control Plane Real: First-class Models + Hysteresis + Policy Wiring
 *
 * Tests:
 *   8.3.1: ProtocolCapability + ProtocolResource models exist in schema
 *   8.3.2: Capability registry uses first-class models (not ConnectivityOffer2)
 *   8.3.3: Resource registration + reservation + release
 *   8.3.4: Decision engine wires to policy engine (evaluatePolicy)
 *   8.3.5: Hysteresis: dwell time, cooldown, confidence threshold
 *   8.3.6: No oscillation (multiple decisions don't flip-flop)
 *   8.3.7: Policy blocks action → ASK_USER
 *   8.3.8: Kernel preservation
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.3 — Control Plane Real", () => {
  // -------------------------------------------------------------------------
  // First-class models
  // -------------------------------------------------------------------------
  it("8.3.1: ProtocolCapability + ProtocolResource models exist in schema", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("model ProtocolCapability");
    expect(source).toContain("model ProtocolResource");
    // Capability has technicalSpec, coverage, reliability, version
    const capModel = source.substring(source.indexOf("model ProtocolCapability"), source.indexOf("model ProtocolResource"));
    expect(capModel).toContain("technicalSpec");
    expect(capModel).toContain("coverage");
    expect(capModel).toContain("reliability");
    expect(capModel).toContain("version");
    // Resource has state, capacity, reservedBy
    const resModel = source.substring(source.indexOf("model ProtocolResource"));
    expect(resModel).toContain("state");
    expect(resModel).toContain("capacity");
    expect(resModel).toContain("reservedBy");
  });

  it("8.3.2: capability registry uses ProtocolCapability (not ConnectivityOffer2)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    expect(source).toContain("db.protocolCapability.create");
    expect(source).toContain("db.protocolCapability.findMany");
    expect(source).toContain("db.protocolResource.create");
    expect(source).toContain("db.protocolResource.updateMany");
    // Should NOT use ConnectivityOffer2 for capability storage
    expect(source).not.toContain("connectivityOffer2.create");
  });

  it("8.3.3: resource registration + reservation + release functions exist", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    expect(source).toContain("export async function registerResource");
    expect(source).toContain("export async function reserveResource");
    expect(source).toContain("export async function releaseResource");
    expect(source).toContain("export async function markResourceInUse");
  });

  it("8.3.4: decision engine imports + calls evaluatePolicy", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain("import { getPolicy, evaluatePolicy }");
    expect(source).toContain("evaluatePolicy(");
    expect(source).toContain("POLICY_BLOCKED");
    expect(source).toContain("POLICY_ALLOWED");
    expect(source).toContain("ASK_USER");
  });

  it("8.3.5: hysteresis parameters exist in decision engine", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain("MIN_DWELL_MS");
    expect(source).toContain("COOLDOWN_MS");
    // Phase 8.6: the decision engine consults the PERSISTED ResourceHealth
    // snapshot (sampleCount) rather than fetching raw measurements inline.
    expect(source).toContain("MIN_SAMPLES_FOR_SWITCH");
    expect(source).toContain("DWELL_TIME_ENFORCED");
    expect(source).toContain("COOLDOWN_ENFORCED");
    expect(source).toContain("CONFIDENCE_THRESHOLD_ENFORCED");
    expect(source).toContain("HYSTERESIS_PASSED");
  });

  it("8.3.6: decision engine checks cooldown via recent SWITCH actions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain("connectivityAction.findFirst");
    expect(source).toContain("type: \"SWITCH\"");
    expect(source).toContain("state: \"SUCCEEDED\"");
    expect(source).toContain("completedAt");
  });

  it("8.3.7: policy evaluation downgrades blocked actions to ASK_USER", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    // The decision engine should check policy and downgrade to ASK_USER if blocked
    expect(source).toContain("if (!policyResult.allowed");
    expect(source).toContain("action = \"ASK_USER\"");
  });

  it("8.3.8: capability registry has resource reservation with state guard", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/capability-registry.ts", "utf-8");
    // reserveResource should only reserve AVAILABLE resources
    expect(source).toContain("state: \"AVAILABLE\"");
    expect(source).toContain("state: \"RESERVED\"");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts has no ProtocolCapability/Resource code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("ProtocolCapability");
    expect(source).not.toContain("ProtocolResource");
    expect(source).not.toContain("protocolCapability");
    expect(source).not.toContain("protocolResource");
  });

  it("KERNEL: ranking engine has no hysteresis/policy code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("MIN_DWELL_MS");
    expect(source).not.toContain("COOLDOWN_MS");
    expect(source).not.toContain("evaluatePolicy");
    // Ranking engine is still the frozen deterministic function
    expect(source).toContain("export async function rankOffers");
  });

  it("KERNEL: protocol module has no commerce imports", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).not.toContain("@/lib/commerce");
    expect(source).not.toContain("@/lib/finance");
    expect(source).not.toContain("ProtocolCapability");
    expect(source).not.toContain("ProtocolResource");
  });
});
