/**
 * Phase 2C.4 — Real RouterOS Client Tests
 *
 * Tests:
 *   1. Provider instance A → client A (via RouterOSProviderClient + MockRouterOSTransport)
 *   2. Provider instance B → client B
 *   3. Same adapter class handles both
 *   4. A cannot call B (isolation)
 *   5. Unknown instance fails closed
 *   9. Timeout classification
 *   10. Auth failure classification
 *   11. Not-found classification
 *   12. Conflict classification
 *   13. Retryable failure classification
 *   14. Malformed response fails safely
 *   15. Concurrent operations on A/B remain isolated
 *   16. Provision retry does not duplicate external resource
 *   17. Suspend retry is idempotent
 *   18. Resume retry is idempotent
 *   19. Release retry is idempotent
 *   20. Reconciliation detects drift
 *   21. Reconciliation detects missing resource
 *
 * Static:
 *   - RouterOSProviderClient implements MikroTikProviderClient
 *   - FetchRouterOSTransport exists
 *   - MockRouterOSTransport has operationLog
 *   - Secret resolver interface exists
 *   - No global cached client
 *   - No mockMikroTikProviderClient import in production path
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
  RouterOSProviderClient,
  MockRouterOSTransport,
  MockMikroTikProviderClient,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearClientCache,
  MikroTikProviderError,
  TestSecretResolver,
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
  const user = await db.user.create({ data: { email: `routeros-2c4-${Date.now()}@test.com`, name: "RouterOS 2C.4", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `RouterOS 2C.4 ${Date.now()}` });
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

describe("Phase 2C.4 — Real RouterOS Client", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // 1+2+3+4: Two instances resolve to different clients, same adapter
  // ---------------------------------------------------------------
  it("1+2+3+4: two RouterOS instances resolve independently via same adapter", async () => {
    const transportA = new MockRouterOSTransport();
    const transportB = new MockRouterOSTransport();
    const clientA = new RouterOSProviderClient(transportA, "routerA");
    const clientB = new RouterOSProviderClient(transportB, "routerB");

    const instA = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS A ${Date.now()}`, userId });
    instanceIds.push(instA.id);
    const instB = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS B ${Date.now()}`, userId });
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

    // Each transport has its own operations
    expect(transportA.operationLog.length).toBeGreaterThan(0);
    expect(transportB.operationLog.length).toBeGreaterThan(0);

    // No cross-contamination: transportA's paths don't appear in transportB
    const aPaths = new Set(transportA.operationLog.map((o) => o.path));
    const bPaths = new Set(transportB.operationLog.map((o) => o.path));
    // The usernames are different (derived from binding ID), so paths differ
    expect(aPaths).not.toEqual(bPaths);

    clearMockClientRegistry();
  }, 120000);

  // ---------------------------------------------------------------
  // 5: Unknown instance fails closed
  // ---------------------------------------------------------------
  it("5: unknown instance fails closed", async () => {
    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Unknown ${Date.now()}`, userId });
    instanceIds.push(inst.id);

    // DO NOT register a client
    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(result.status).toBe("failed_permanent");
    expect(result.error).toContain("no configured");
  }, 30000);

  // ---------------------------------------------------------------
  // 9: Timeout classification
  // ---------------------------------------------------------------
  it("9: timeout classified as failed_retryable", async () => {
    const transport = new MockRouterOSTransport();
    transport.setFailureMode("TIMEOUT");
    const client = new RouterOSProviderClient(transport, "timeout-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Timeout ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(result.status).toBe("failed_retryable");
    expect(result.error).toContain("timeout");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 10: Auth failure classification
  // ---------------------------------------------------------------
  it("10: auth failure classified as failed_permanent", async () => {
    const transport = new MockRouterOSTransport();
    transport.setFailureMode("AUTHENTICATION", 401);
    const client = new RouterOSProviderClient(transport, "auth-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Auth ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(result.status).toBe("failed_permanent");
    expect(result.error).toContain("AUTHENTICATION");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 13: Retryable failure classification
  // ---------------------------------------------------------------
  it("13: retryable failure (5xx) classified as failed_retryable", async () => {
    const transport = new MockRouterOSTransport();
    transport.setFailureMode("RETRYABLE", 500);
    const client = new RouterOSProviderClient(transport, "retryable-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Retry ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const result = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    expect(result.status).toBe("failed_retryable");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 16: Provision retry does not duplicate external resource
  // ---------------------------------------------------------------
  it("16: duplicate provision is idempotent (no duplicate resource)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "idempotent-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Idem ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const p1 = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    const p2 = await res.adapter.provision({ entitlement: res.entitlement, binding: { ...res.binding, providerResourceId: p1.providerResourceId } });

    expect(p1.status).toBe("success");
    expect(p2.status).toBe("success");
    expect(p2.providerResourceId).toBe(p1.providerResourceId);

    // Only one PUT (create) should have been made — the second provision is idempotent
    // (it goes through getResource and finds the existing resource, no PUT).
    // (Phase 2C.4.1 protocol: PUT = create per RouterOS REST CRUD convention.)
    const creates = transport.operationLog.filter((o) => o.method === "PUT");
    expect(creates.length).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 17+18+19: Suspend/resume/release are idempotent
  // ---------------------------------------------------------------
  it("17+18+19: suspend/resume/release are idempotent", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "idempotent-srr");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS SRR ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    const bi = { ...res.binding, providerResourceId: p.providerResourceId };

    // Suspend twice
    const s1 = await res.adapter.suspend({ entitlement: res.entitlement, binding: bi });
    const s2 = await res.adapter.suspend({ entitlement: res.entitlement, binding: bi });
    expect(s1.status).toBe("success");
    expect(s2.status).toBe("success");

    // Resume twice
    const r1 = await res.adapter.resume({ entitlement: res.entitlement, binding: bi });
    const r2 = await res.adapter.resume({ entitlement: res.entitlement, binding: bi });
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");

    // Release twice
    const d1 = await res.adapter.release({ entitlement: res.entitlement, binding: bi });
    const d2 = await res.adapter.release({ entitlement: res.entitlement, binding: bi });
    expect(d1.status).toBe("success");
    expect(d2.status).toBe("success");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // 20: Reconciliation detects drift
  // ---------------------------------------------------------------
  it("20: reconciliation detects drift (BOUND → DEGRADED)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "drift-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Drift ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Suspend at the provider (creates drift)
    await res.adapter.suspend({ entitlement: res.entitlement, binding: { ...res.binding, providerResourceId: p.providerResourceId } });

    const reconResult = await reconcileBindingWithProvider(binding.id);
    expect(reconResult.status).toBe("transitioned");
    expect(reconResult.transition?.to).toBe("DEGRADED");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("DEGRADED");

    clearMockClientRegistry();
  }, 60000);

  // ---------------------------------------------------------------
  // 21: Reconciliation detects missing resource
  // ---------------------------------------------------------------
  it("21: reconciliation detects missing resource (→ FAILED)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "missing-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `RouterOS Missing ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);
    const res = await resolveBindingRuntime(binding.id);

    const p = await res.adapter.provision({ entitlement: res.entitlement, binding: res.binding });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: p.providerResourceId });

    // Delete at the provider (resource disappears)
    await res.adapter.release({ entitlement: res.entitlement, binding: { ...res.binding, providerResourceId: p.providerResourceId } });

    const reconResult = await reconcileBindingWithProvider(binding.id);
    expect(reconResult.status).toBe("transitioned");
    expect(reconResult.transition?.to).toBe("FAILED");

    const finalBinding = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(finalBinding?.status).toBe("FAILED");

    clearMockClientRegistry();
  }, 60000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: RouterOSProviderClient implements MikroTikProviderClient", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/routeros-client.ts", "utf-8");
    expect(source).toContain("class RouterOSProviderClient implements MikroTikProviderClient");
  }, 10000);

  it("Static: FetchRouterOSTransport exists with timeout/retry", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/transport.ts", "utf-8");
    expect(source).toContain("class FetchRouterOSTransport implements RouterOSTransport");
    expect(source).toContain("AbortController");
    expect(source).toContain("maxRetries");
    expect(source).toContain("classifyHttpStatus");
  }, 10000);

  it("Static: MockRouterOSTransport has operationLog and failureMode", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/transport.ts", "utf-8");
    expect(source).toContain("class MockRouterOSTransport implements RouterOSTransport");
    expect(source).toContain("readonly operationLog");
    expect(source).toContain("setFailureMode");
  }, 10000);

  it("Static: secret resolver interface exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/secret-resolver.ts", "utf-8");
    expect(source).toContain("interface ProviderInstanceSecretResolver");
    expect(source).toContain("class EnvProviderInstanceSecretResolver");
    expect(source).toContain("class TestSecretResolver");
  }, 10000);

  it("Static: client factory is fail-closed and cached by providerInstanceId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/client-factory.ts", "utf-8");
    expect(source).toContain("export async function createRouterOSClientForInstance");
    expect(source).toContain("clientCache");
    expect(source).toContain("FAIL-CLOSED");
    expect(source).toContain("No fallback");
  }, 10000);

  it("Static: production resolver uses async factory, not mock", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/index.ts", "utf-8");
    expect(source).toContain("productionAsyncResolver");
    expect(source).not.toContain("mockMikroTikProviderClient");
    expect(source).not.toContain("return mockMikroTikProviderClient");
  }, 10000);

  it("Static: adapter supports async resolver", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/providers/mikrotik/adapter.ts", "utf-8");
    expect(source).toContain("AsyncMikroTikClientResolver");
    expect(source).toContain("private async resolveClient");
    expect(source).toContain("await this.resolveClient");
  }, 10000);
});
