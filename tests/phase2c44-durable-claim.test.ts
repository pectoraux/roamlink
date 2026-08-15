/**
 * Phase 2C.4.4 — Durable Provisioning Claim / Concurrent Create Safety
 *
 * Tests:
 *   A. Single provision succeeds (UNBOUND → PROVISIONING → BOUND)
 *   B. Concurrent provision calls → exactly ONE adapter.provision() call
 *   C. Second worker seeing PROVISIONING → claim_lost (no PUT)
 *   D. Already BOUND → already_provisioned (no PUT)
 *   E. Provisioning failure → FAILED
 *   F. FAILED → can retry (PROVISIONING → BOUND on second attempt)
 *   G. provisionBinding stores providerResourceId after success
 *
 * Static:
 *   - claimProvisioning exists
 *   - provisionBinding exists
 *   - claim uses updateMany WHERE status=UNBOUND
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
  provisionBinding,
  claimProvisioning,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
  RouterOSProviderClient,
  MockRouterOSTransport,
  registerMockClientForInstance,
  clearMockClientRegistry,
  clearClientCache,
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
  const user = await db.user.create({ data: { email: `claim-2c44-${Date.now()}@test.com`, name: "Claim 2C.4.4", passwordHash: await hashPassword("test12345"), role: "customer" } });
  userId = user.id;
  const tenant = await createTenant({ name: `Claim 2C.4.4 ${Date.now()}` });
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

describe("Phase 2C.4.4 — Durable Provisioning Claim", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // ---------------------------------------------------------------
  // A: Single provision succeeds
  // ---------------------------------------------------------------
  it("A: single provision succeeds (UNBOUND → PROVISIONING → BOUND)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "single-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Single ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("success");
    expect(result.providerResourceId).toBeTruthy();

    // Binding is now BOUND
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");
    expect(bindingAfter?.providerResourceId).toBeTruthy();
    expect(bindingAfter?.provisioningState).toBe("COMPLETED");

    // Exactly one PUT was made
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(1);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // B: Concurrent provision → exactly ONE adapter.provision() call
  // ---------------------------------------------------------------
  it("B: concurrent provision → exactly ONE PUT (durable claim)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "concurrent-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Concurrent ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Run concurrent provisions
    const results = await Promise.allSettled([
      provisionBinding(binding.id),
      provisionBinding(binding.id),
    ]);

    // At least one should succeed
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === "success").length;
    expect(successes).toBe(1);

    // The other should be claim_lost or already_provisioned
    const others = results.filter((r) => r.status === "fulfilled" && r.value.status !== "success");
    expect(others.length).toBe(1);
    expect(["claim_lost", "already_provisioned"]).toContain((others[0] as any).value.status);

    // CRITICAL: exactly ONE PUT — the durable claim prevented the second worker from issuing PUT
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(1);

    // Binding is BOUND
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // C: Second worker seeing PROVISIONING → claim_lost
  // ---------------------------------------------------------------
  it("C: second worker seeing PROVISIONING → claim_lost (no PUT)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "claim-lost-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router ClaimLost ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Manually transition to PROVISIONING (simulate another worker claiming it)
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });

    // Now provisionBinding should see PROVISIONING → claim_lost
    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("claim_lost");

    // CRITICAL: zero PUTs (the second worker didn't issue PUT)
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // D: Already BOUND → already_provisioned
  // ---------------------------------------------------------------
  it("D: already BOUND → already_provisioned (no PUT)", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "already-bound-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router AlreadyBound ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // Manually transition to BOUND
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.BOUND, providerResourceId: "*preexisting" });

    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("already_provisioned");
    expect(result.providerResourceId).toBe("*preexisting");

    // CRITICAL: zero PUTs
    const puts = transport.operationLog.filter((o) => o.method === "PUT");
    expect(puts.length).toBe(0);

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // E: Provisioning failure → FAILED
  // ---------------------------------------------------------------
  it("E: provisioning failure → FAILED", async () => {
    const transport = new MockRouterOSTransport();
    transport.setFailureMode("PERMANENT", 400);
    const client = new RouterOSProviderClient(transport, "fail-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Fail ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    const result = await provisionBinding(binding.id);
    expect(result.status).toBe("failed_permanent");

    // Binding is FAILED
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("FAILED");

    clearMockClientRegistry();
  }, 30000);

  // ---------------------------------------------------------------
  // F: FAILED → can retry (PROVISIONING → BOUND on second attempt)
  // ---------------------------------------------------------------
  it("F: FAILED → retry succeeds", async () => {
    const transport = new MockRouterOSTransport();
    const client = new RouterOSProviderClient(transport, "retry-test");

    const inst = await createProviderInstance({ tenantId, providerType: "mikrotik", name: `Router Retry ${Date.now()}`, userId });
    instanceIds.push(inst.id);
    registerMockClientForInstance(inst.id, client);

    const { binding } = await createBindingWithInstance(inst.id);

    // First attempt fails (simulate by failing the first GET lookup)
    transport.setFailureMode("PERMANENT", 400, ["/ip/hotspot/user?name="]);
    const result1 = await provisionBinding(binding.id);
    expect(result1.status).toBe("failed_permanent");

    // Clear failure
    transport.clearFailureMode();

    // Transition FAILED → PROVISIONING (retry)
    await transitionBinding({ bindingId: binding.id, toState: BINDING_STATES.PROVISIONING });

    // Second attempt succeeds
    const result2 = await provisionBinding(binding.id);
    expect(result2.status).toBe("success");

    // Binding is BOUND
    const bindingAfter = await db.providerResourceBinding.findUnique({ where: { id: binding.id } });
    expect(bindingAfter?.status).toBe("BOUND");

    clearMockClientRegistry();
  }, 120000);

  // ---------------------------------------------------------------
  // Static tests
  // ---------------------------------------------------------------
  it("Static: claimProvisioning exists with guarded updateMany", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("export async function claimProvisioning");
    expect(source).toContain("where: { id: bindingId, status: BINDING_STATES.UNBOUND }");
  }, 10000);

  it("Static: provisionBinding exists with claim + adapter call", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).toContain("export async function provisionBinding");
    expect(source).toContain("claimProvisioning");
    expect(source).toContain("adapter.provision");
  }, 10000);

  it("Static: provisionBinding exported from index", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/index.ts", "utf-8");
    expect(source).toContain("claimProvisioning");
    expect(source).toContain("provisionBinding");
  }, 10000);
});
