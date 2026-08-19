/**
 * Phase 2C.4.3 — RouterOS Create Fail-Closed + Live Protocol Verification
 *
 * Tests:
 *   A. Initial lookup timeout → zero PUT requests (fail closed)
 *   B. Initial lookup 5xx → zero PUT requests (fail closed)
 *   C. Initial lookup 404/absence → exactly one PUT
 *   D. Existing resource → zero PUT
 *   E. PUT timeout → GET reconciliation
 *   F. PUT timeout + resource exists → no second PUT
 *   G. PUT timeout + confirmed absent → exactly one controlled retry
 *   H. Concurrent create calls remain safe (idempotent)
 *
 * Static:
 *   - No "proceeding to create" in lookup failure path
 *   - create_lookup_failed_closed present
 *   - FAIL CLOSED documented
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import {
  seedConnectivityCapabilities,
  createEntitlement,
  transitionEntitlement,
  createResourceBinding,
  createProviderInstance,
  resolveBindingRuntime,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  RouterOSProviderClient,
  MockRouterOSTransport,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearClientCache,
  MikroTikProviderError,
} from "@/lib/connectivity";
import { hashPassword } from "@/lib/security";
import { createTenant, addTenantUser } from "@/lib/tenant/service";

let setupDone = false;
let tenantId: string;
let userId: string;
let subscriptionId: string;
const entitlementIds: string[] = [];
const bindingIds: string[] = [];
const instanceIds: string[] = [];

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({ data: { email: `failclosed-2c43-${Date.now()}@test.com`, name: "FailClosed 2C.4.3", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `FailClosed 2C.4.3 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const sub = await db.tenantSubscription.create({ data: { tenantId, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionId = sub.id;
}

afterAll(async () => {
  try {
    clearMockClientRegistry();
    clearClientCache();
    for (const bid of bindingIds) await db.providerResourceBinding.deleteMany({ where: { id: bid } }).catch(() => {});
    for (const iid of instanceIds) await db.connectivityProviderInstance.deleteMany({ where: { id: iid } }).catch(() => {});
    for (const eid of entitlementIds) { await db.providerResourceBinding.deleteMany({ where: { entitlementId: eid } }).catch(() => {}); await db.connectivityEntitlement.deleteMany({ where: { id: eid } }).catch(() => {}); }
    if (subscriptionId) await db.tenantSubscription.deleteMany({ where: { id: subscriptionId } }).catch(() => {});
    if (tenantId) { await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {}); await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {}); }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

async function createBindingWithInstance(instanceId: string) {
  const ent = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });
  const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mikrotik", resourceType: "hotspot_user", providerInstanceId: instanceId, userId });
  bindingIds.push(binding.id);
  return { ent, binding };
}

describe("Phase 2C.4.3 — RouterOS Create Fail-Closed", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // A: Initial lookup timeout → zero PUT requests
  // ---------------------------------------------------------------
  it("A: initial lookup timeout → zero PUT requests (fail closed)", async () => {
    const transport = new MockRouterOSTransport();
    // Make GET ?name= fail with TIMEOUT
    transport.setFailureMode("TIMEOUT", undefined, ["/ip/hotspot/user?name="]);
    const client = new RouterOSProviderClient(transport, "fc-timeout");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC Timeout ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    // CRITICAL: must FAIL, not proceed to PUT
    expect(result.status).toBe("failed_retryable");
    expect(result.error).toContain("timeout");

    // CRITICAL: zero PUT requests
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // B: Initial lookup 5xx → zero PUT requests
  // ---------------------------------------------------------------
  it("B: initial lookup 5xx → zero PUT requests (fail closed)", async () => {
    const transport = new MockRouterOSTransport();
    transport.setFailureMode("RETRYABLE", 500, ["/ip/hotspot/user?name="]);
    const client = new RouterOSProviderClient(transport, "fc-5xx");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC 5xx ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("failed_retryable");

    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // C: Initial lookup 404/absence → exactly one PUT
  // ---------------------------------------------------------------
  it("C: initial lookup absent → exactly one PUT", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "fc-absent");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC Absent ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("success");

    const puts = transport.operationLog.filter((o) => o.method === "PUT" && o.path === "/ip/hotspot/user");
    expect(puts.length).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // D: Existing resource → zero PUT
  // ---------------------------------------------------------------
  it("D: existing resource → zero PUT (idempotent return)", async () => {
    const transport = new MockRouterOSTransport();
    // Pre-populate with a resource
    transport.resources.set("rl-" + "existingtest", {
      ".id": "*existing", name: "rl-existingtest", password: "pw",
      disabled: "false", "rate-limit": "", createdAt: new Date(),
      downloadBytes: 0, uploadBytes: 0, sessionStartTime: new Date(),
    });

    const client = new RouterOSProviderClient(transport, "fc-existing");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC Existing ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    // The adapter generates a deterministic username from the binding ID.
    // We need the lookup to find the resource. Let's create a binding and
    // check what username the adapter would generate, then pre-populate.
    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    // The adapter generates username as `rl-${binding.id.slice(-12)}`
    const expectedUsername = `rl-${binding.id.slice(-12)}`;
    transport.resources.set(expectedUsername, {
      ".id": "*preexisting", name: expectedUsername, password: "pw",
      disabled: "false", "rate-limit": "", createdAt: new Date(),
      downloadBytes: 0, uploadBytes: 0, sessionStartTime: new Date(),
    });

    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("success");

    // CRITICAL: zero PUT (resource already exists → returned existing)
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // E+F: PUT timeout → GET reconciliation
  // ---------------------------------------------------------------
  it("E+F: PUT timeout → GET reconciliation, resource exists → no second PUT", async () => {
    const transport = new MockRouterOSTransport();
    let putCount = 0;
    const originalRequest = transport.request.bind(transport);
    transport.request = async (input: any) => {
      if (input.method === "PUT") {
        putCount++;
        if (putCount === 1) {
          // First PUT times out, but the resource was actually created
          transport.operationLog.push({ method: "PUT", path: input.path, timestamp: new Date() });
          // Simulate that the PUT reached the server — create the resource
          const username = input.body?.name as string;
          transport.resources.set(username, {
            ".id": `*${Date.now().toString(36)}`, name: username, password: input.body?.password ?? "",
            "rate-limit": input.body?.["rate-limit"] ?? "", disabled: "false",
            createdAt: new Date(), downloadBytes: 0, uploadBytes: 0, sessionStartTime: new Date(),
          });
          throw new MikroTikProviderError("TIMEOUT", "Simulated timeout on first PUT");
        }
      }
      return originalRequest(input);
    };

    const client = new RouterOSProviderClient(transport, "fc-put-timeout");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC PUTTimeout ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("success");

    // CRITICAL: exactly ONE PUT (the first one that timed out)
    // The client reconciled via GET, found the resource, returned it
    // → no second PUT needed
    expect(putCount).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // G: PUT timeout + confirmed absent → exactly one controlled retry
  // ---------------------------------------------------------------
  it("G: PUT timeout + confirmed absent → exactly one controlled retry", async () => {
    const transport = new MockRouterOSTransport();
    let putCount = 0;
    const originalRequest = transport.request.bind(transport);
    transport.request = async (input: any) => {
      if (input.method === "PUT") {
        putCount++;
        if (putCount === 1) {
          transport.operationLog.push({ method: "PUT", path: input.path, timestamp: new Date() });
          throw new MikroTikProviderError("TIMEOUT", "Simulated timeout on first PUT");
        }
      }
      return originalRequest(input);
    };

    const client = new RouterOSProviderClient(transport, "fc-put-retry");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC PUTRetry ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("success");

    // CRITICAL: exactly TWO PUTs:
    //   1st PUT: timeout (transport does NOT retry)
    //   Client reconciles via GET → resource absent
    //   2nd PUT: client-controlled retry (succeeds)
    expect(putCount).toBe(2);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // H: Concurrent create calls remain safe
  // ---------------------------------------------------------------
  it("H: concurrent create calls → idempotent (one resource, no duplicate)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "fc-concurrent");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router FC Concurrent ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    // Run concurrent provisions
    const results = await Promise.allSettled([
      res.adapter.provision({ entitlement: res.entitlement, binding: res.binding }),
      res.adapter.provision({ entitlement: res.entitlement, binding: res.binding }),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === "success").length;
    expect(successes).toBeGreaterThanOrEqual(1);

    // At most 2 PUTs (one from each concurrent call) — the mock is idempotent
    const puts = transport.operationLog.filter((o) => o.method === "PUT" && o.path === "/ip/hotspot/user");
    expect(puts.length).toBeLessThanOrEqual(2);

    // But only ONE resource should exist (idempotent)
    expect(transport.resources.size).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: no 'proceeding to create' in lookup failure path", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    expect(source).not.toContain("proceeding to create");
    expect(source).not.toContain("Idempotency lookup failed — proceeding to create");
  }, 10000);

  it("Static: create_lookup_failed_closed present (fail-closed logging)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    expect(source).toContain("create_lookup_failed_closed");
    expect(source).toContain("refusing to create with unknown external state");
  }, 10000);

  it("Static: FAIL CLOSED documented in createResource", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    expect(source).toContain("FAIL CLOSED on lookup uncertainty");
    expect(source).toContain("Unknown external state");
    expect(source).toContain("Only confirmed absence permits creation");
  }, 10000);

  // -------------------------------------------------------------------------
  // Phase 12.4.2a.15 — Uncertain PUT + failed reconciliation GET → NO second PUT
  //
  // The architect's P0 finding: after an ambiguous PUT outcome (TIMEOUT),
  // if the reconciliation GET itself fails, the client MUST NOT issue a
  // second PUT. The external outcome is still unknown — the provider may
  // have created the resource despite the ambiguous response. A second PUT
  // could create a duplicate.
  //
  // The safe state machine:
  //   PUT → TIMEOUT
  //     → reconciliation GET
  //       ├─ found → converge
  //       ├─ authoritative 404 → retry PUT (safe)
  //       └─ GET fails (TIMEOUT/RETRYABLE) → FAIL CLOSED (no second PUT)
  // -------------------------------------------------------------------------
  it("12.4.2a.15: PUT timeout + reconciliation GET also fails → NO second PUT, RECONCILIATION_REQUIRED", async () => {
    const transport = new MockRouterOSTransport();

    // Step 1: Initial GET (lookup) returns empty (resource absent).
    // Step 2: PUT fails with TIMEOUT.
    // Step 3: Reconciliation GET also fails with TIMEOUT.
    // The client must NOT issue a second PUT.

    let putCount = 0;
    let getCount = 0;

    // Wrap the transport to count operations and control failures.
    const originalRequest = transport.request.bind(transport);

    // Phase 1: initial GET → empty (absent), PUT → TIMEOUT, reconciliation GET → TIMEOUT
    let phase: "initial-get" | "put" | "reconcile-get" | "done" = "initial-get";

    transport.request = async (input: any) => {
      if (input.method === "GET" && input.path.includes("?name=")) {
        getCount++;
        if (phase === "initial-get") {
          phase = "put";
          return []; // resource absent — proceed to PUT
        }
        if (phase === "reconcile-get") {
          // Reconciliation GET fails with TIMEOUT
          throw new MikroTikProviderError("TIMEOUT", "Simulated reconciliation GET timeout");
        }
        return [];
      }
      if (input.method === "PUT") {
        putCount++;
        if (phase === "put") {
          phase = "reconcile-get";
          throw new MikroTikProviderError("TIMEOUT", "Simulated PUT timeout");
        }
        // Any subsequent PUT should not happen
        throw new Error("UNEXPECTED: second PUT was issued after failed reconciliation GET");
      }
      return originalRequest(input);
    };

    const client = new RouterOSProviderClient(transport, "test-instance");

    // The createResource call should throw (not succeed, not retry PUT).
    let caughtError: unknown = null;
    try {
      await client.createResource({
        resourceType: "hotspot_user",
        username: "test-uncertain-create-15",
        password: "password123",
        downloadRateLimitBps: 50_000_000,
        uploadRateLimitBps: 10_000_000,
      });
    } catch (err) {
      caughtError = err;
    }

    // Assert: an error was thrown (not a successful return).
    expect(caughtError).not.toBeNull();
    expect(caughtError).toBeInstanceOf(MikroTikProviderError);

    // Assert: the error is RETRYABLE (not PERMANENT) — the external outcome
    // is unknown, so the caller should escalate to RECONCILIATION_REQUIRED.
    const error = caughtError as MikroTikProviderError;
    expect(error.errorType === "RETRYABLE" || error.errorType === "TIMEOUT").toBe(true);

    // Assert: exactly ONE PUT was issued (the initial attempt).
    // NO second PUT was issued after the failed reconciliation GET.
    expect(putCount).toBe(1);

    // Assert: exactly TWO GETs were issued (initial lookup + reconciliation).
    expect(getCount).toBe(2);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 12.4.2a.16 — Uncertain PUT + authoritative 404 → one retry PUT allowed
  //
  // The complementary proof: if the reconciliation GET returns an authoritative
  // 404 / empty result (NOT a transport failure), the resource genuinely does
  // not exist, and a single retry PUT is safe.
  // -------------------------------------------------------------------------
  it("12.4.2a.16: PUT timeout + authoritative 404 → one retry PUT allowed, succeeds", async () => {
    const transport = new MockRouterOSTransport();

    let putCount = 0;

    // Phase 1: initial GET → empty, PUT → TIMEOUT, reconciliation GET → empty (authoritative 404),
    // retry PUT → success.
    let phase: "initial-get" | "put" | "reconcile-get" | "retry-put" = "initial-get";

    const originalRequest = transport.request.bind(transport);
    transport.request = async (input: any) => {
      if (input.method === "GET" && input.path.includes("?name=")) {
        if (phase === "initial-get") {
          phase = "put";
          return []; // resource absent
        }
        if (phase === "reconcile-get") {
          phase = "retry-put";
          return []; // authoritative 404 — resource genuinely absent
        }
        return [];
      }
      if (input.method === "PUT") {
        putCount++;
        if (phase === "put") {
          phase = "reconcile-get";
          throw new MikroTikProviderError("TIMEOUT", "Simulated PUT timeout");
        }
        if (phase === "retry-put") {
          // Retry PUT succeeds — use the original transport to create the resource.
          return originalRequest(input);
        }
      }
      return originalRequest(input);
    };

    const client = new RouterOSProviderClient(transport, "test-instance");

    const result = await client.createResource({
      resourceType: "hotspot_user",
      username: "test-uncertain-create-16",
      password: "password123",
      downloadRateLimitBps: 50_000_000,
      uploadRateLimitBps: 10_000_000,
    });

    // Assert: the create succeeded (returned a resource).
    expect(result).toBeDefined();
    expect(result.username).toBe("test-uncertain-create-16");

    // Assert: exactly TWO PUTs were issued (initial + retry).
    expect(putCount).toBe(2);

    // Assert: exactly ONE resource exists at the provider (no duplicate).
    const resources = Array.from(transport.resources.values());
    const matching = resources.filter((r) => r.name === "test-uncertain-create-16");
    expect(matching.length).toBe(1);
  }, 30_000);
});
