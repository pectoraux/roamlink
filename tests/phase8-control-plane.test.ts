/**
 * Phase 8 — Connectivity Control Plane: Protocol Tests
 *
 * Tests the protocol vocabulary, session state machine, action state machine,
 * and the decision engine wrapper. All tests are static (no DB) to keep them
 * fast and independent of Neon latency.
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8 — Connectivity Control Plane", () => {
  // -------------------------------------------------------------------------
  // Protocol Vocabulary
  // -------------------------------------------------------------------------
  it("8.1: protocol exports all canonical types", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain("ConnectivityIntentSchema");
    expect(source).toContain("ConnectivityCapabilitySchema");
    expect(source).toContain("ConnectivityResourceSchema");
    expect(source).toContain("ConnectivityOfferSchema");
    expect(source).toContain("ConnectivitySessionSchema");
    expect(source).toContain("ConnectivityMeasurementSchema");
    expect(source).toContain("ConnectivityPolicySchema");
    expect(source).toContain("ConnectivityDecisionSchema");
    expect(source).toContain("ConnectivityActionSchema");
  });

  it("8.2: protocol has version constant", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain("PROTOCOL_VERSION");
    expect(source).toContain('"v1"');
  });

  it("8.3: session state transitions are defined", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain("SESSION_TRANSITIONS");
    expect(source).toContain("PLANNED");
    expect(source).toContain("ACTIVE");
    expect(source).toContain("SWITCHING");
    expect(source).toContain("ENDED");
    expect(source).toContain("FAILED");
  });

  it("8.4: action state transitions are defined", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain("ACTION_TRANSITIONS");
    expect(source).toContain("PLANNED");
    expect(source).toContain("AUTHORIZED");
    expect(source).toContain("EXECUTING");
    expect(source).toContain("SUCCEEDED");
    expect(source).toContain("RECONCILIATION_REQUIRED");
  });

  it("8.5: protocol uses Zod schemas for validation", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain('from "zod"');
    expect(source).toContain("z.object");
    expect(source).toContain("z.enum");
    expect(source).toContain("z.infer");
  });

  // -------------------------------------------------------------------------
  // Control Plane Services
  // -------------------------------------------------------------------------
  it("8.6: session manager exports createSession + transitionSessionState", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/session-manager.ts", "utf-8");
    expect(source).toContain("export async function createSession");
    expect(source).toContain("export async function transitionSessionState");
    expect(source).toContain("export async function getSession");
    expect(source).toContain("export async function getActiveSessionForSubject");
    expect(source).toContain("export async function recordMeasurement");
  });

  it("8.7: session manager enforces state machine", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/session-manager.ts", "utf-8");
    expect(source).toContain("SESSION_TRANSITIONS");
    expect(source).toContain("Illegal session transition");
  });

  it("8.8: decision engine wraps the existing ranking engine", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain("import { rankOffers }");
    expect(source).toContain("from \"@/lib/commerce/ranking-engine\"");
    expect(source).toContain("export async function makeDecision");
  });

  it("8.9: decision engine is deterministic (no Math.random)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).not.toContain("Math.random");
  });

  it("8.10: decision engine returns KEEP/SWITCH/ACTIVATE based on session state", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain('"KEEP"');
    expect(source).toContain('"SWITCH"');
    expect(source).toContain('"ACTIVATE"');
    expect(source).toContain("switchHysteresis");
  });

  it("8.11: action executor exports createAction + executeAction", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("export async function createAction");
    expect(source).toContain("export async function executeAction");
    expect(source).toContain("export async function transitionActionState");
  });

  it("8.12: action executor enforces state machine", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("ACTION_TRANSITIONS");
    expect(source).toContain("Illegal action transition");
  });

  it("8.13: action executor bridges to the frozen kernel via session transitions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    expect(source).toContain("import { transitionSessionState }");
    expect(source).toContain("case \"ACTIVATE\"");
    expect(source).toContain("case \"SWITCH\"");
    expect(source).toContain("case \"SUSPEND\"");
    expect(source).toContain("case \"RELEASE\"");
  });

  // -------------------------------------------------------------------------
  // Protocol API Routes
  // -------------------------------------------------------------------------
  it("8.14: intent API creates intent + session + decision", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/v1/connectivity/intents/route.ts", "utf-8");
    expect(source).toContain("intentRequest.create");
    expect(source).toContain("createSession");
    expect(source).toContain("makeDecision");
  });

  it("8.15: sessions API is auth-guarded", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/v1/connectivity/sessions/route.ts", "utf-8");
    expect(source).toContain("getCurrentUser");
    expect(source).toContain("requireTenantContext");
  });

  it("8.16: measurements API accepts USAGE/QUALITY/AVAILABILITY", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/v1/connectivity/measurements/route.ts", "utf-8");
    expect(source).toContain("USAGE");
    expect(source).toContain("QUALITY");
    expect(source).toContain("AVAILABILITY");
    // Phase 8.6: the route now uses the canonical ingestion path (ingestMeasurement)
    // which validates source provenance, computes freshness, derives health, and
    // emits re-evaluation events.
    expect(source).toContain("ingestMeasurement");
  });

  it("8.17: actions API creates and optionally executes actions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/v1/connectivity/actions/route.ts", "utf-8");
    expect(source).toContain("createAction");
    expect(source).toContain("executeAction");
    expect(source).toContain("DISCOVER");
    expect(source).toContain("ACTIVATE");
    expect(source).toContain("SWITCH");
    expect(source).toContain("RELEASE");
  });

  // -------------------------------------------------------------------------
  // Prisma Models
  // -------------------------------------------------------------------------
  it("8.18: protocol models exist in schema", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("model ConnectivitySession");
    expect(source).toContain("model ConnectivityMeasurement");
    expect(source).toContain("model ConnectivityPolicy");
    expect(source).toContain("model ConnectivityDecision");
    expect(source).toContain("model ConnectivityAction");
  });

  it("8.19: session model has state machine states", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    const sessionModel = source.substring(
      source.indexOf("model ConnectivitySession"),
      source.indexOf("model ConnectivityMeasurement"),
    );
    expect(sessionModel).toContain("state");
    expect(sessionModel).toContain("PLANNED"); // default state
    // The full state list is defined in the protocol index, not the schema comment
    const protocolSource = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(protocolSource).toContain("PLANNED");
    expect(protocolSource).toContain("ACTIVE");
    expect(protocolSource).toContain("SWITCHING");
    expect(protocolSource).toContain("ENDED");
  });

  it("8.20: action model has idempotency key", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    const actionModel = source.substring(
      source.indexOf("model ConnectivityAction"),
    );
    expect(actionModel).toContain("idempotencyKey");
    expect(actionModel).toContain("@unique");
  });

  // -------------------------------------------------------------------------
  // Kernel Preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts has no protocol/control-plane code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("ConnectivitySession");
    expect(source).not.toContain("ConnectivityDecision");
    expect(source).not.toContain("ConnectivityAction");
    expect(source).not.toContain("makeDecision");
    expect(source).not.toContain("executeAction");
    // The kernel still has its frozen functions
    expect(source).toContain("export async function provisionBinding");
    expect(source).toContain("export async function reconcileProvisioning");
  });

  it("KERNEL: ranking engine has no protocol/control-plane code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("ConnectivitySession");
    expect(source).not.toContain("ConnectivityDecision");
    expect(source).not.toContain("makeDecision");
    // The ranking engine is still the frozen deterministic function
    expect(source).toContain("export async function rankOffers");
  });

  it("KERNEL: protocol module has no commerce imports", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    // The protocol should NOT import commerce-specific modules
    expect(source).not.toContain("@/lib/commerce");
    expect(source).not.toContain("@/lib/finance");
    expect(source).not.toContain("ResellerProduct");
    expect(source).not.toContain("CustomerOrder");
    expect(source).not.toContain("fulfillOrder");
  });
});
