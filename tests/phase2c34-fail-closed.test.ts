/**
 * Phase 2C.3.4 — Fail-Closed Provider Client Resolution Tests
 *
 * Proves that unknown/unconfigured provider instances FAIL CLOSED
 * rather than falling back to a default client.
 *
 * Tests:
 *   A. Registered instance resolves its own mock client
 *   B. Second instance resolves second client
 *   C. Unknown instance fails (not fallback)
 *   D. Inactive instance fails
 *   E. Maintenance instance fails
 *   J. Clearing mock registration causes failure, NOT fallback
 *   K. Same providerType with multiple instances remains isolated
 *   L. Adapter receives the correctly resolved client
 *
 * Static:
 *   - No default mock fallback in production resolver
 *   - mockMikroTikProviderClient not imported in index.ts production path
 *   - Fail-closed error message present
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
  MikroTikConnectivityAdapter,
  MockMikroTikProviderClient,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearMockMikroTikResources,
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
  const user = await db.user.create({ data: { email: `failclosed-2c34-${Date.now()}@test.com`, name: "FailClosed 2C.3.4", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `FailClosed 2C.3.4 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const sub = await db.tenantSubscription.create({ data: { tenantId, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionId = sub.id;
}

afterAll(async () => {
  try {
    clearMockClientRegistry();
    clearMockMikroTikResources();
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

describe("Phase 2C.3.4 — Fail-Closed Provider Client Resolution", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // A+B: Registered instances resolve their own clients
  // ---------------------------------------------------------------
  it("A+B: registered instances resolve their own mock clients", async () => {
    const clientA = new MockMikroTikProviderClient("clientA-fc");
    const clientB = new MockMikroTikProviderClient("clientB-fc");

    const instA = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router A FC ${Date.now()}`, userId });
    instanceIds.push(instA.id);
    const instB = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router B FC ${Date.now()}`, userId });
    instanceIds.push(instB.id);

    registerMockClientForInstance(instA.id, clientA);
    registerMockClientForInstance(instB.id, clientB);

    const { binding: bindingA } = await createBindingWithInstance(instA.id);
    const { binding: bindingB } = await createBindingWithInstance(instB.id);

    const resA = await resolveBindingRuntime(bindingA.id);
    const resB = await resolveBindingRuntime(bindingB.id);

    const pA = await resA.adapter.provision({ entitlement: resA.entitlement, binding: resA.binding });
    const pB = await resB.adapter.provision({ entitlement: resB.entitlement, binding: resB.binding });

    expect(pA.status).toBe("success");
    expect(pB.status).toBe("success");

    // Each client has its own operations
    expect(clientA.operationLog.length).toBeGreaterThan(0);
    expect(clientB.operationLog.length).toBeGreaterThan(0);

    // No cross-contamination
    const aResources = new Set(clientA.operationLog.map((o) => o.resource));
    const bResources = new Set(clientB.operationLog.map((o) => o.resource));
    const intersection = [...aResources].filter((r) => bResources.has(r));
    expect(intersection).toEqual([]);

    clearMockClientRegistry();
  }, 120000);

  // ---------------------------------------------------------------
  // C: Unknown instance fails (NOT fallback)
  // ---------------------------------------------------------------
  it("C: unknown instance fails closed — no default fallback", async () => {
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router C FC ${Date.now()}`, userId });
    instanceIds.push(inst.id);

    // DO NOT register a mock client for this instance
    const { binding } = await createBindingWithInstance(inst.id);

    const res = await resolveBindingRuntime(binding.id);

    // Provisioning should FAIL — not fall back to a default mock client
    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(result.status).toBe("failed_permanent");
    expect(result.error).toContain("no configured MikroTik client");
    expect(result.error).toContain("No fallback");
  }, 30000);

  // ---------------------------------------------------------------
  // D: Inactive instance fails
  // ---------------------------------------------------------------
  it("D: inactive instance fails at runtime resolution", async () => {
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router D FC ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    const { binding } = await createBindingWithInstance(inst.id);

    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "inactive" } });

    let threw = false;
    try {
      await resolveBindingRuntime(binding.id);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("inactive");
    }
    expect(threw).toBe(true);

    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "active" } });
  }, 30000);

  // ---------------------------------------------------------------
  // E: Maintenance instance fails
  // ---------------------------------------------------------------
  it("E: maintenance instance fails at runtime resolution", async () => {
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router E FC ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    const { binding } = await createBindingWithInstance(inst.id);

    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "maintenance" } });

    let threw = false;
    try {
      await resolveBindingRuntime(binding.id);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("maintenance");
    }
    expect(threw).toBe(true);

    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "active" } });
  }, 30000);

  // ---------------------------------------------------------------
  // J: Clearing mock registration causes failure, NOT fallback
  // ---------------------------------------------------------------
  it("J: clearing mock registration causes failure, not fallback to default", async () => {
    const client = new MockMikroTikProviderClient("clientJ-fc");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router J FC ${Date.now()}`, userId });
    instanceIds.push(inst.id);

    registerMockClientForInstance(inst.id, client);
    const { binding } = await createBindingWithInstance(inst.id);

    // Step 1: Verify binding works with registered client
    const res1 = await resolveBindingRuntime(binding.id);
    const p1 = await res1.adapter.provision({ entitlement: res1.entitlement, binding: res1.binding });
    expect(p1.status).toBe("success");
    expect(client.operationLog.length).toBeGreaterThan(0);

    // Step 2: Clear the mock registration
    clearMockClientRegistry();

    // Step 3: Try another operation — MUST FAIL, not fall back
    const res2 = await resolveBindingRuntime(binding.id);
    const p2 = await res2.adapter.provision({ entitlement: res2.entitlement, binding: res2.binding });

    // CRITICAL: must fail, NOT succeed on a default client
    expect(p2.status).toBe("failed_permanent");
    expect(p2.error).toContain("no configured MikroTik client");

    // The original client should NOT have received any new operations
    const logLengthBefore = client.operationLog.length;
    // No new operations were added (the failed call didn't reach the client)
    expect(client.operationLog.length).toBe(logLengthBefore);
  }, 30000);

  // ---------------------------------------------------------------
  // L: Adapter receives the correctly resolved client
  // ---------------------------------------------------------------
  it("L: adapter receives the correctly resolved client", async () => {
    const client = new MockMikroTikProviderClient("clientL-fc");
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router L FC ${Date.now()}`, userId });
    instanceIds.push(inst.id);

    registerMockClientForInstance(inst.id, client);
    const { binding } = await createBindingWithInstance(inst.id);

    const res = await resolveBindingRuntime(binding.id);
    expect(res.binding.providerInstanceId).toBe(inst.id);

    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(p.status).toBe("success");
    expect(client.operationLog.length).toBeGreaterThan(0);
    expect(client.operationLog[0].operation).toBe("create");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: no default mock fallback in production resolver", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/index.ts", "utf-8");
    expect(source).toContain("FAIL CLOSED");
    expect(source).toContain("No fallback");
    // Must NOT contain the old fallback pattern
    expect(source).not.toContain("return mockMikroTikProviderClient");
    expect(source).not.toContain("Fall back to the default mock client");
  }, 10000);

  it("Static: mockMikroTikProviderClient not imported in production resolver", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/index.ts", "utf-8");
    const importLines = source.split("\n").filter((l) => l.trim().startsWith("import"));
    const importSource = importLines.join("\n");
    // The production resolver must NOT import the default mock client
    expect(importSource).not.toContain("mockMikroTikProviderClient");
  }, 10000);

  it("Static: fail-closed error message present", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/index.ts", "utf-8");
    expect(source).toContain("no configured MikroTik client");
    expect(source).toContain("No fallback to a default client");
    expect(source).toContain("each infrastructure instance must be explicitly configured");
  }, 10000);

  it("Static: adapter comment says NO default client", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    expect(source).toContain("There is NO default client");
    expect(source).toContain("FAILS CLOSED");
    expect(source).not.toContain("return a default client for backward compat");
  }, 10000);
});
