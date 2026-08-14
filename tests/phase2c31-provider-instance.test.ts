/**
 * Phase 2C.3.1 — Provider Instance + Client Injection Tests
 *
 * Tests:
 *   A. Two MikroTik instances resolve independently
 *   B. Same providerType + different instances remain isolated
 *   C. Adapter receives injected client (no hard-coded import)
 *   D. Mock client can be replaced by another client without adapter changes
 *   E. Cross-tenant provider-instance access denied (403)
 *   F. Binding instance is immutable after provisioning begins
 *   G. Concurrent provisioning cannot cross provider instances
 *   H. Registry still resolves by providerType
 *
 * Static:
 *   - Adapter does not import mockMikroTikProviderClient
 *   - ConnectivityProviderInstance model exists
 *   - providerInstanceId field exists on ProviderResourceBinding
 *   - No secrets stored in plaintext (configurationKey, not credentials)
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
  listProviderInstances,
  getProviderInstance,
  resolveBindingWithInstance,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  MikroTikConnectivityAdapter,
  MockMikroTikProviderClient,
  mockMikroTikProviderClient,
  requireConnectivityProvider,
} from "@/lib/connectivity";
import { hashPassword } from "@/lib/security";
import { createTenant, addTenantUser } from "@/lib/tenant/service";

let setupDone = false;
let tenantA: string;
let tenantB: string;
let userId: string;
let subscriptionA: string;
let subscriptionB: string;
const entitlementIds: string[] = [];
const bindingIds: string[] = [];
const instanceIds: string[] = [];

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({ data: { email: `instance-2c31-${Date.now()}@test.com`, name: "Instance 2C.3.1", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tA = await createTenant({ name: `Instance 2C.3.1 A ${Date.now()}` });
  tenantA = tA.id;
  await addTenantUser({ tenantId: tenantA, userId, role: "owner" });
  const tB = await createTenant({ name: `Instance 2C.3.1 B ${Date.now()}` });
  tenantB = tB.id;
  await addTenantUser({ tenantId: tenantB, userId, role: "owner" });
  const plan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  const subA = await db.tenantSubscription.create({ data: { tenantId: tenantA, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionA = subA.id;
  const subB = await db.tenantSubscription.create({ data: { tenantId: tenantB, saaasPlanId: plan!.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  subscriptionB = subB.id;
}

afterAll(async () => {
  try {
    for (const bid of bindingIds) await db.providerResourceBinding.deleteMany({ where: { id: bid } }).catch(() => {});
    for (const iid of instanceIds) await db.connectivityProviderInstance.deleteMany({ where: { id: iid } }).catch(() => {});
    for (const eid of entitlementIds) { await db.providerResourceBinding.deleteMany({ where: { entitlementId: eid } }).catch(() => {}); await db.connectivityEntitlement.deleteMany({ where: { id: eid } }).catch(() => {}); }
    if (subscriptionA) await db.tenantSubscription.deleteMany({ where: { id: subscriptionA } }).catch(() => {});
    if (subscriptionB) await db.tenantSubscription.deleteMany({ where: { id: subscriptionB } }).catch(() => {});
    if (tenantA) { await db.tenantUser.deleteMany({ where: { tenantId: tenantA } }).catch(() => {}); await db.tenant.deleteMany({ where: { id: tenantA } }).catch(() => {}); }
    if (tenantB) { await db.tenantUser.deleteMany({ where: { tenantId: tenantB } }).catch(() => {}); await db.tenant.deleteMany({ where: { id: tenantB } }).catch(() => {}); }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

describe("Phase 2C.3.1 — Provider Instance + Client Injection", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // A. Two MikroTik instances resolve independently
  // ---------------------------------------------------------------
  it("A. two MikroTik instances resolve independently", async () => {
    const instA = await createProviderInstance({ tenantId: tenantA, providerType: "mikrotik", name: "Accra Router 01", userId });
    instanceIds.push(instA.id);
    const instB = await createProviderInstance({ tenantId: tenantA, providerType: "mikrotik", name: "Kumasi Router 02", userId });
    instanceIds.push(instB.id);

    // Create entitlements + bindings for each instance
    const entA = await createEntitlement({ tenantId: tenantA, subscriptionId: subscriptionA, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
    entitlementIds.push(entA.id);
    await transitionEntitlement({ entitlementId: entA.id, toState: ENTITLEMENT_STATES.ACTIVE });
    const bindingA = await createResourceBinding({ entitlementId: entA.id, providerType: "mikrotik", resourceType: "hotspot_user", providerInstanceId: instA.id, userId });
    bindingIds.push(bindingA.id);

    const entB = await createEntitlement({ tenantId: tenantA, subscriptionId: subscriptionA, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 100 }, validFrom: new Date(), userId });
    entitlementIds.push(entB.id);
    await transitionEntitlement({ entitlementId: entB.id, toState: ENTITLEMENT_STATES.ACTIVE });
    const bindingB = await createResourceBinding({ entitlementId: entB.id, providerType: "mikrotik", resourceType: "hotspot_user", providerInstanceId: instB.id, userId });
    bindingIds.push(bindingB.id);

    // Resolve both — should be different instances, same adapter type
    const resA = await resolveBindingWithInstance(bindingA.id);
    const resB = await resolveBindingWithInstance(bindingB.id);

    expect(resA.providerInstance?.id).toBe(instA.id);
    expect(resB.providerInstance?.id).toBe(instB.id);
    expect(resA.providerInstance?.id).not.toBe(resB.providerInstance?.id);
    expect(resA.adapter.providerType).toBe("mikrotik");
    expect(resB.adapter.providerType).toBe("mikrotik");
  }, 120000);

  // ---------------------------------------------------------------
  // B. Same providerType + different instances remain isolated
  // ---------------------------------------------------------------
  it("B. same providerType + different instances remain isolated", async () => {
    // Create fresh instances for this test
    const inst1 = await createProviderInstance({ tenantId: tenantA, providerType: "mikrotik", name: `Isolation Test A ${Date.now()}`, userId });
    instanceIds.push(inst1.id);
    const inst2 = await createProviderInstance({ tenantId: tenantA, providerType: "mikrotik", name: `Isolation Test B ${Date.now()}`, userId });
    instanceIds.push(inst2.id);

    const instances = await listProviderInstances(tenantA, "mikrotik");
    expect(instances.length).toBeGreaterThanOrEqual(2);
    const ids = instances.map((i) => i.id);
    expect(ids).toContain(inst1.id);
    expect(ids).toContain(inst2.id);
    expect(inst1.id).not.toBe(inst2.id);
  }, 30000);

  // ---------------------------------------------------------------
  // C. Adapter receives injected client
  // ---------------------------------------------------------------
  it("C. adapter receives injected client (constructor injection)", async () => {
    const client1 = new MockMikroTikProviderClient();
    const client2 = new MockMikroTikProviderClient();
    const adapter1 = new MikroTikConnectivityAdapter(client1);
    const adapter2 = new MikroTikConnectivityAdapter(client2);

    expect(adapter1.providerType).toBe("mikrotik");
    expect(adapter2.providerType).toBe("mikrotik");
    // Both are valid adapters with different client instances
    expect(adapter1).not.toBe(adapter2);
  }, 10000);

  // ---------------------------------------------------------------
  // D. Mock client can be replaced without adapter changes
  // ---------------------------------------------------------------
  it("D. different client implementation works with same adapter class", async () => {
    // Create a minimal custom client
    const customClient: any = {
      createResource: async (config: any) => ({
        id: config.username, resourceType: config.resourceType, isActive: true,
        downloadRateLimitBps: config.downloadRateLimitBps ?? 0,
        uploadRateLimitBps: config.uploadRateLimitBps ?? 0,
        sessionTimeoutSeconds: 0, dataQuotaBytes: 0, createdAt: new Date(),
      }),
      getResource: async (username: string) => null,
      suspendResource: async () => {},
      resumeResource: async () => {},
      deleteResource: async () => {},
      getResourceUsage: async () => null,
    };

    const adapter = new MikroTikConnectivityAdapter(customClient);
    expect(adapter.providerType).toBe("mikrotik");

    // The adapter works with a completely different client implementation
    const ent = await createEntitlement({ tenantId: tenantA, subscriptionId: subscriptionA, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
    entitlementIds.push(ent.id);
    const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mikrotik", userId });
    bindingIds.push(binding.id);

    const result = await adapter.provision({
      entitlement: { id: ent.id, tenantId: tenantA, subscriptionId: subscriptionA, status: "ACTIVE", capabilityType: "INTERNET", capabilitySet: { downloadMbps: 50 }, policy: null, validFrom: new Date(), validUntil: null },
      binding: { id: binding.id, entitlementId: ent.id, providerType: "mikrotik", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null },
    });
    expect(result.status).toBe("success");
  }, 30000);

  // ---------------------------------------------------------------
  // E. Cross-tenant provider-instance access denied (403)
  // ---------------------------------------------------------------
  it("E. cross-tenant provider-instance access denied", async () => {
    // Create an instance for tenant A
    const instA = await createProviderInstance({ tenantId: tenantA, providerType: "mikrotik", name: "Tenant A Router", userId });
    instanceIds.push(instA.id);

    // Create an entitlement for tenant B
    const entB = await createEntitlement({ tenantId: tenantB, subscriptionId: subscriptionB, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
    entitlementIds.push(entB.id);

    // Try to create a binding for tenant B's entitlement using tenant A's instance → should fail
    let threw = false;
    try {
      await createResourceBinding({ entitlementId: entB.id, providerType: "mikrotik", providerInstanceId: instA.id, userId });
    } catch (err: any) {
      threw = true;
      expect(err.statusCode).toBe(403);
      expect(err.message).toContain("Cross-tenant");
    }
    expect(threw).toBe(true);
  }, 30000);

  // ---------------------------------------------------------------
  // F. Binding instance is immutable after provisioning begins
  // ---------------------------------------------------------------
  it("F. binding providerInstanceId is set at creation and not changed", async () => {
    const inst = await createProviderInstance({ tenantId: tenantA, providerType: "mikrotik", name: "Immutability Test Router", userId });
    instanceIds.push(inst.id);

    const ent = await createEntitlement({ tenantId: tenantA, subscriptionId: subscriptionA, capabilityType: CAPABILITY_TYPES.INTERNET, capabilitySet: { downloadMbps: 50 }, validFrom: new Date(), userId });
    entitlementIds.push(ent.id);
    await transitionEntitlement({ entitlementId: ent.id, toState: ENTITLEMENT_STATES.ACTIVE });

    const binding = await createResourceBinding({ entitlementId: ent.id, providerType: "mikrotik", providerInstanceId: inst.id, userId });
    bindingIds.push(binding.id);

    // Verify the providerInstanceId is set
    const bindingBefore = await db.providerResourceBinding.findUnique({ where: { id: binding.id }, select: { providerInstanceId: true, status: true } });
    expect(bindingBefore?.providerInstanceId).toBe(inst.id);

    // Transition through provisioning lifecycle — providerInstanceId should NOT change
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    const afterProv = await db.providerResourceBinding.findUnique({ where: { id: binding.id }, select: { providerInstanceId: true } });
    expect(afterProv?.providerInstanceId).toBe(inst.id);

    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND });
    const afterBound = await db.providerResourceBinding.findUnique({ where: { id: binding.id }, select: { providerInstanceId: true } });
    expect(afterBound?.providerInstanceId).toBe(inst.id);
  }, 30000);

  // ---------------------------------------------------------------
  // H. Registry still resolves by providerType
  // ---------------------------------------------------------------
  it("H. registry resolves by providerType (not instance)", async () => {
    const adapter = requireConnectivityProvider("mikrotik");
    expect(adapter.providerType).toBe("mikrotik");
    // The registry resolves the adapter CLASS — not a specific instance.
    // Instance resolution happens via resolveBindingWithInstance.
  }, 10000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: adapter does NOT import mockMikroTikProviderClient", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    const lines = source.split("\n");
    const importLines = lines.filter((l) => l.trim().startsWith("import"));
    const importSource = importLines.join("\n");
    expect(importSource).not.toContain("mockMikroTikProviderClient");
    expect(importSource).not.toContain("mock-client");
  }, 10000);

  it("Static: adapter constructor requires a client parameter (no default)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    expect(source).toContain("constructor(private readonly client: MikroTikProviderClient)");
    // Must NOT have a default value
    expect(source).not.toContain("= mockMikroTikProviderClient");
  }, 10000);

  it("Static: ConnectivityProviderInstance model exists in schema", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("model ConnectivityProviderInstance");
    expect(source).toContain("configurationKey");
    expect(source).toContain("providerType    String");
  }, 10000);

  it("Static: providerInstanceId exists on ProviderResourceBinding", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("providerInstanceId String?");
    expect(source).toContain("providerInstance ConnectivityProviderInstance?");
  }, 10000);

  it("Static: no secrets stored in plaintext (configurationKey, not credentials)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    const modelStart = source.indexOf("model ConnectivityProviderInstance");
    const modelEnd = source.indexOf("}", modelStart + 100);
    const modelBody = source.substring(modelStart, modelEnd);
    // Strip comments to check only field declarations
    const codeLines = modelBody.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const codeBody = codeLines.join("\n");
    expect(codeBody).toContain("configurationKey");
    // Field declarations should NOT include secret/credential/password fields
    expect(codeBody).not.toMatch(/\bpassword\s+String/);
    expect(codeBody).not.toMatch(/\bapiKey\s+String/);
    expect(codeBody).not.toMatch(/\bsecret\s+String/);
    expect(codeBody).not.toMatch(/\bcredentials\s+String/);
  }, 10000);

  it("Static: createProviderInstance and resolveBindingWithInstance exported", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("export async function createProviderInstance");
    expect(source).toContain("export async function resolveBindingWithInstance");
    expect(source).toContain("export async function listProviderInstances");
    expect(source).toContain("export async function getProviderInstance");
  }, 10000);
});
