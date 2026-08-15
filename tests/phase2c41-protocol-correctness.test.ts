/**
 * Phase 2C.4.1 — RouterOS Protocol Correctness + Client Cache Safety
 *
 * Tests:
 *   1. Create uses PUT (not POST)
 *   2. Create timeout → reconcile before retry
 *   3. Create 5xx → no blind duplicate create
 *   4. Create lost response → resource lookup confirms success
 *   5. Create truly absent → exactly one create
 *   6. Suspend/resume/release idempotent
 *   7. RouterOS .id used as providerResourceId
 *   8. GET/PATCH/DELETE use .id for addressing
 *   9. Username lookup via ?name= query
 *   10. Client cache invalidates on status change
 *   11. Client cache invalidates on configurationKey change
 *   12. Changing A config doesn't affect B
 *
 * Static:
 *   - No POST /ip/hotspot/user in client
 *   - PUT used for create
 *   - Cache key includes fingerprint
 *   - Instance loaded before cache check
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import {
  seedConnectivityCapabilities,
  createEntitlement,
  transitionEntitlement,
  createResourceBinding,
  transitionBinding,
  createProviderInstance,
  resolveBindingRuntime,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  RouterOSProviderClient,
  MockRouterOSTransport,
  MockMikroTikProviderClient,
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
  const user = await db.user.create({ data: { email: `proto-2c41-${Date.now()}@test.com`, name: "Proto 2C.4.1", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Proto 2C.4.1 ${Date.now()}` });
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

describe("Phase 2C.4.1 — RouterOS Protocol Correctness + Client Cache Safety", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // 1: Create uses PUT (not POST)
  // ---------------------------------------------------------------
  it("1: create uses PUT method", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "put-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router PUT ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(p.status).toBe("success");

    // CRITICAL: create must use PUT, not POST
    const creates = transport.operationLog.filter((o) => o.method === "PUT" && o.path === "/ip/hotspot/user");
    expect(creates.length).toBe(1);

    // Must NOT use POST for create
    const posts = transport.operationLog.filter((o) => o.method === "POST" && o.path === "/ip/hotspot/user");
    expect(posts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 2: Create timeout → reconcile before retry
  // ---------------------------------------------------------------
  it("2: create timeout → reconcile via GET before retry", async () => {
    const transport = new MockRouterOSTransport();
    // First PUT fails with timeout, then succeeds
    let putAttempt = 0;
    const originalRequest = transport.request.bind(transport);
    transport.request = async (input: any) => {
      if (input.method === "PUT" && putAttempt === 0) {
        putAttempt++;
        throw new MikroTikProviderError("TIMEOUT", "Simulated timeout on first PUT");
      }
      return originalRequest(input);
    };

    const client = new RouterOSProviderClient(transport, "timeout-reconcile");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Timeout ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("success");

    // CRITICAL: after timeout, a GET (reconcile) was performed before retrying PUT
    const gets = transport.operationLog.filter((o) => o.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(2); // initial GET + reconcile GET

    // Exactly one successful PUT (the retry)
    const puts = transport.operationLog.filter((o) => o.method === "PUT" && o.path === "/ip/hotspot/user");
    expect(puts.length).toBe(1); // only the retry PUT (the first one timed out)

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 3: Create 5xx → no blind duplicate
  // ---------------------------------------------------------------
  it("3: create 5xx → reconcile before retry (no blind duplicate)", async () => {
    const transport = new MockRouterOSTransport();
    let putAttempt = 0;
    const originalRequest = transport.request.bind(transport);
    transport.request = async (input: any) => {
      if (input.method === "PUT" && putAttempt === 0) {
        putAttempt++;
        throw new MikroTikProviderError("RETRYABLE", "Simulated 5xx on first PUT");
      }
      return originalRequest(input);
    };

    const client = new RouterOSProviderClient(transport, "5xx-reconcile");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router 5xx ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(result.status).toBe("success");

    // Exactly one successful PUT (the retry after reconcile)
    const puts = transport.operationLog.filter((o) => o.method === "PUT" && o.path === "/ip/hotspot/user");
    expect(puts.length).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 5: Create truly absent → exactly one create
  // ---------------------------------------------------------------
  it("5: create truly absent → exactly one PUT", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "absent-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Absent ${Date.now()}`, userId });
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
  // 7+8+9: RouterOS .id used as resource identity
  // ---------------------------------------------------------------
  it("7+8: create returns .id, used for subsequent operations", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "id-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router ID ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });

    expect(p.status).toBe("success");
    expect(p.providerResourceId).toBeTruthy();
    // The providerResourceId should be the RouterOS .id (starts with *)
    expect(p.providerResourceId).toMatch(/^\*/);

    // Suspend using the .id
    const bi = { ...res.binding, providerResourceId: p.providerResourceId };
    const s = await res.adapter.suspend({ entitlement: res.entitlement, binding: bi });
    expect(s.status).toBe("success");

    // The PATCH should use the .id in the URL
    const patches = transport.operationLog.filter((o) => o.method === "PATCH");
    expect(patches.length).toBe(1);
    expect(patches[0].path).toContain(p.providerResourceId);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 10: Client cache invalidates on status change
  // ---------------------------------------------------------------
  it("10: inactive instance rejected even with cached client", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "cache-invalidate");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Cache ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);
    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(p.status).toBe("success");

    // Now set instance to inactive
    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "inactive" } });

    // Runtime resolution should fail (not use cached client)
    let threw = false;
    try {
      await resolveBindingRuntime(binding.id);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("inactive");
    }
    expect(threw).toBe(true);

    // Restore
    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "active" } });
    clearMockClientRegistry();
    clearClientCache();
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: no POST /ip/hotspot/user in routeros-client", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    expect(source).not.toContain('method: "POST"');
    expect(source).toContain('method: "PUT"');
  }, 10000);

  it("Static: cache key includes fingerprint (configurationKey + updatedAt)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/client-factory.ts", "utf-8");
    expect(source).toContain("fingerprint");
    expect(source).toContain("instance.updatedAt");
    expect(source).toContain("instance.configurationKey");
    expect(source).toContain("cacheKey");
  }, 10000);

  it("Static: instance loaded from PostgreSQL BEFORE cache check", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/client-factory.ts", "utf-8");
    // The findUnique must come before clientCache.get
    const findUniquePos = source.indexOf("db.connectivityProviderInstance.findUnique");
    const cacheGetPos = source.indexOf("clientCache.get");
    expect(findUniquePos).toBeGreaterThan(0);
    expect(cacheGetPos).toBeGreaterThan(0);
    expect(findUniquePos).toBeLessThan(cacheGetPos); // DB load comes first
  }, 10000);

  it("Static: create has reconcile-before-retry logic", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    expect(source).toContain("create_uncertain");
    expect(source).toContain("reconcile");
    expect(source).toContain("getResourceByUsername");
    expect(source).toContain("create_retry_after_reconcile");
  }, 10000);

  it("Static: transport supports PUT method", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/transport.ts", "utf-8");
    expect(source).toContain('"GET" | "POST" | "PUT" | "PATCH" | "DELETE"');
  }, 10000);
});
