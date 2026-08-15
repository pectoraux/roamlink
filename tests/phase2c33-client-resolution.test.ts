/**
 * Phase 2C.3.3 — Provider Instance → Client Resolution Tests
 *
 * Proves that different providerInstanceId values resolve to different
 * provider clients, with real runtime evidence that no cross-instance
 * operations occur.
 *
 * Tests:
 *   E. Provisioning binding A calls client A only
 *   F. Provisioning binding B calls client B only
 *   G. Client A never receives binding B operations
 *   H. Client B never receives binding A operations
 *   I. Concurrent provisioning on A/B remains isolated
 *   J. Reconciliation A uses client A
 *   K. Reconciliation B uses client B
 *   M. Unknown/inactive instance cannot resolve a client
 *
 * Static:
 *   - Adapter uses clientResolver, not fixed client
 *   - MikroTikClientResolver type exists
 *   - MockMikroTikProviderClient has operationLog
 *   - registerMockClientForInstance exported
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
  reconcileBindingWithProvider,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  MikroTikConnectivityAdapter,
  MockMikroTikProviderClient,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearMockMikroTikResources,
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

// Per-test client instances
let clientA: MockMikroTikProviderClient;
let clientB: MockMikroTikProviderClient;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({ data: { email: `client-2c33-${Date.now()}@test.com`, name: "Client 2C.3.3", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Client 2C.3.3 ${Date.now()}` });
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

/** Helper: create a binding linked to a specific provider instance */
async function createBindingWithInstance(instanceId: string) {
  const ent = await createEntitlement({ tenantId, subscriptionId, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
  entitlementIds.push(ent.id);
  await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });
  const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mikrotik", resourceType: "hotspot_user", providerInstanceId: instanceId, userId });
  bindingIds.push(binding.id);
  return { ent, binding };
}

describe("Phase 2C.3.3 — Provider Instance → Client Resolution", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // E+F+G+H: Provisioning calls the correct client
  // ---------------------------------------------------------------
  it("E+F+G+H: provisioning A calls clientA only, B calls clientB only", async () => {
    // Create two separate mock clients
    clientA = new MockMikroTikProviderClient("clientA");
    clientB = new MockMikroTikProviderClient("clientB");

    // Create two provider instances
    const instA = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router A ${Date.now()}`, userId });
    instanceIds.push(instA.id);
    const instB = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router B ${Date.now()}`, userId });
    instanceIds.push(instB.id);

    // Register specific clients for each instance
    registerMockClientForInstance(instA.id, clientA);
    registerMockClientForInstance(instB.id, clientB);

    // Create bindings for each instance
    const { binding: bindingA } = await createBindingWithInstance(instA.id);
    const { binding: bindingB } = await createBindingWithInstance(instB.id);

    // Resolve runtime for both — should use different clients
    const resA = await resolveBindingRuntime(bindingA.id);
    const resB = await resolveBindingRuntime(bindingB.id);

    // Provision A — should call clientA
    const provisionA = await resA.adapter.provision({
      entitlement: resA.entitlement,
      binding: resA.binding,
    });
    expect(provisionA.status).toBe("success");

    // Provision B — should call clientB
    const provisionB = await resB.adapter.provision({
      entitlement: resB.entitlement,
      binding: resB.binding,
    });
    expect(provisionB.status).toBe("success");

    // CRITICAL: clientA has operations, clientB has operations
    expect(clientA.operationLog.length).toBeGreaterThan(0);
    expect(clientB.operationLog.length).toBeGreaterThan(0);

    // CRITICAL: clientA's operations are for binding A's resource, not B's
    const clientAResources = clientA.operationLog.map((o) => o.resource);
    const clientBResources = clientB.operationLog.map((o) => o.resource);

    // The resource IDs should be different (different bindings → different usernames)
    expect(clientAResources).not.toEqual(clientBResources);

    // CRITICAL: clientA should NOT have any operations for clientB's resource
    const clientBResourceIds = new Set(clientBResources);
    const crossContamination = clientAResources.filter((r) => clientBResourceIds.has(r));
    expect(crossContamination).toEqual([]);

    // Clean up
    clearMockClientRegistry();
  }, 120000);

  // ---------------------------------------------------------------
  // I: Concurrent provisioning remains isolated
  // ---------------------------------------------------------------
  it("I: concurrent provisioning on A/B remains isolated", async () => {
    clientA = new MockMikroTikProviderClient("clientA-concurrent");
    clientB = new MockMikroTikProviderClient("clientB-concurrent");

    const instA = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router A C ${Date.now()}`, userId });
    instanceIds.push(instA.id);
    const instB = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router B C ${Date.now()}`, userId });
    instanceIds.push(instB.id);

    registerMockClientForInstance(instA.id, clientA);
    registerMockClientForInstance(instB.id, clientB);

    const { binding: bindingA } = await createBindingWithInstance(instA.id);
    const { binding: bindingB } = await createBindingWithInstance(instB.id);

    const resA = await resolveBindingRuntime(bindingA.id);
    const resB = await resolveBindingRuntime(bindingB.id);

    // Run concurrent provisioning
    const [resultA, resultB] = await Promise.all([
      resA.adapter.provision({ entitlement: resA.entitlement, binding: resA.binding }),
      resB.adapter.provision({ entitlement: resB.entitlement, binding: resB.binding }),
    ]);

    expect(resultA.status).toBe("success");
    expect(resultB.status).toBe("success");

    // Each client should have exactly its own operations
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
  // J+K: Reconciliation uses the correct client
  // ---------------------------------------------------------------
  it("J+K: reconciliation A uses clientA, B uses clientB", async () => {
    clientA = new MockMikroTikProviderClient("clientA-recon");
    clientB = new MockMikroTikProviderClient("clientB-recon");

    const instA = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router A R ${Date.now()}`, userId });
    instanceIds.push(instA.id);
    const instB = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router B R ${Date.now()}`, userId });
    instanceIds.push(instB.id);

    registerMockClientForInstance(instA.id, clientA);
    registerMockClientForInstance(instB.id, clientB);

    const { binding: bindingA } = await createBindingWithInstance(instA.id);
    const { binding: bindingB } = await createBindingWithInstance(instB.id);

    // Provision both via the adapter
    const resA = await resolveBindingRuntime(bindingA.id);
    const resB = await resolveBindingRuntime(bindingB.id);
    const pA = await resA.adapter.provision({ entitlement: resA.entitlement, binding: resA.binding });
    const pB = await resB.adapter.provision({ entitlement: resB.entitlement, binding: resB.binding });

    // Transition to BOUND
    await transitionBinding({ bindingId: bindingA.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: bindingA.id, toState: BINDING_STATES.BOUND, providerResourceId: pA.providerResourceId });
    await transitionBinding({ bindingId: bindingB.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: bindingB.id, toState: BINDING_STATES.BOUND, providerResourceId: pB.providerResourceId });

    // Clear operation logs before reconciliation
    clientA.operationLog.length = 0;
    clientB.operationLog.length = 0;

    // Reconcile A
    const reconA = await reconcileBindingWithProvider(bindingA.id);
    expect(reconA.status).toBe("in_sync");

    // Reconcile B
    const reconB = await reconcileBindingWithProvider(bindingB.id);
    expect(reconB.status).toBe("in_sync");

    // CRITICAL: clientA had operations (reconcile calls getResource), clientB had operations
    expect(clientA.operationLog.length).toBeGreaterThan(0);
    expect(clientB.operationLog.length).toBeGreaterThan(0);

    // CRITICAL: no cross-contamination
    const aResources = new Set(clientA.operationLog.map((o) => o.resource));
    const bResources = new Set(clientB.operationLog.map((o) => o.resource));
    const intersection = [...aResources].filter((r) => bResources.has(r));
    expect(intersection).toEqual([]);

    clearMockClientRegistry();
  }, 120000);

  // ---------------------------------------------------------------
  // M: Inactive instance cannot resolve a client at runtime
  // ---------------------------------------------------------------
  it("M: inactive instance rejected at runtime", async () => {
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router M ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    const { binding } = await createBindingWithInstance(inst.id);

    // Deactivate the instance
    await db.connectivityProviderInstance.update({ where: { id: inst.id }, data: { status: "inactive" } });

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
  }, 30000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: adapter uses clientResolver, not fixed client", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    expect(source).toContain("clientResolver: MikroTikClientResolver");
    expect(source).toContain("resolveClient(binding: ProviderResourceBindingInput)");
    expect(source).not.toContain("private readonly client: MikroTikProviderClient");
  }, 10000);

  it("Static: MikroTikClientResolver type exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/client.ts", "utf-8");
    expect(source).toContain("export type MikroTikClientResolver");
  }, 10000);

  it("Static: MockMikroTikProviderClient has operationLog", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/mock-client.ts", "utf-8");
    expect(source).toContain("readonly operationLog");
    expect(source).toContain("this.operationLog.push");
  }, 10000);

  it("Static: registerMockClientForInstance exported", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/index.ts", "utf-8");
    expect(source).toContain("export function registerMockClientForInstance");
    expect(source).toContain("export function clearMockClientRegistry");
    expect(source).toContain("mockClientRegistry");
  }, 10000);

  it("Static: mock client uses per-instance resources (not global)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/mock-client.ts", "utf-8");
    expect(source).toContain("private readonly resources = new Map");
    // Should NOT use the global mockResources for per-client operations
    const classStart = source.indexOf("export class MockMikroTikProviderClient");
    const classEnd = source.indexOf("export const mockMikroTikProviderClient", classStart);
    const classBody = source.substring(classStart, classEnd);
    // All resource operations inside the class should use this.resources, not mockResources
    expect(classBody).not.toContain("mockResources.get(");
    expect(classBody).not.toContain("mockResources.set(");
    expect(classBody).not.toContain("mockResources.has(");
    expect(classBody).not.toContain("mockResources.delete(");
  }, 10000);
});
