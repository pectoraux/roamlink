/**
 * Phase 12.4.6.2 — API Rate Limiting Tests (original, updated for counter model).
 *
 * Updated for Phase 12.4.6.1: uses RateLimitCounter (atomic fixed-window)
 * instead of RateLimitEvent (INSERT-then-COUNT).
 *
 * These tests are superseded by the more rigorous 12.4.6.1.* tests, but kept
 * for backward compatibility. They verify the same basic behavior with
 * simpler assertions.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { createTenant } from "@/lib/tenant/service";
import {
  checkRateLimit,
  pruneRateLimitEvents,
  DEFAULT_KEY_LIMIT_PER_MINUTE,
  SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE,
} from "@/lib/api/rate-limit";

type Fixture = {
  tenantId: string;
  apiKeyId: string;
  apiKeyId2: string;
  tenantId2: string;
  apiKeyIdB: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const slug = `p12462-${Date.now().toString(36)}`;
  const tenant = await createTenant({ name: `P12462 ${slug}`, slug, status: "active" });
  const tenant2 = await createTenant({ name: `P12462B ${slug}`, slug: `b-${slug}`, status: "active" });

  const cleanup = async () => {
    await db.rateLimitCounter.deleteMany({ where: { scopeId: { contains: tenant.id } } }).catch(() => {});
    await db.rateLimitCounter.deleteMany({ where: { scopeId: { contains: tenant2.id } } }).catch(() => {});
    await db.rateLimitEvent.deleteMany({ where: { tenantId: { in: [tenant.id, tenant2.id] } } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: { in: [tenant.id, tenant2.id] } } }).catch(() => {});
  };

  return {
    tenantId: tenant.id,
    apiKeyId: `key-A-${slug}`,
    apiKeyId2: `key-B-${slug}`,
    tenantId2: tenant2.id,
    apiKeyIdB: `key-C-${slug}`,
    cleanup,
  };
}

describe("Phase 12.4.6.2 — API Rate Limiting (original)", () => {
  let fx: Fixture;
  beforeAll(async () => {
    await pruneRateLimitEvents();
    fx = await setupFixture();
  }, 30_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 30_000);

  async function cleanScope(scopeId: string) {
    await db.rateLimitCounter.deleteMany({ where: { scopeId } }).catch(() => {});
  }

  // 12.4.6.2.1 — limit boundary: N succeeds, N+1 → denied
  it("12.4.6.2.1: per-key limit boundary — N succeeds, N+1 denied", async () => {
    const path = "/api/v1/test-endpoint";
    const limit = DEFAULT_KEY_LIMIT_PER_MINUTE;

    for (let i = 0; i < limit; i++) {
      const result = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
      expect(result.allowed).toBe(true);
    }

    const denied = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);

    await cleanScope(fx.apiKeyId);
    await cleanScope(fx.tenantId);
  }, 30_000);

  // 12.4.6.2.2 — two API keys in same tenant (separate per-key limits)
  it("12.4.6.2.2: two keys same tenant — separate per-key limits", async () => {
    const path = "/api/v1/test-aggregate";
    const limit = DEFAULT_KEY_LIMIT_PER_MINUTE;

    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
      expect(r.allowed).toBe(true);
    }

    // Key B (same tenant) can still make requests (separate per-key limit).
    const r2 = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId2, path });
    expect(r2.allowed).toBe(true);

    await cleanScope(fx.apiKeyId);
    await cleanScope(fx.apiKeyId2);
    await cleanScope(fx.tenantId);
  }, 30_000);

  // 12.4.6.2.3 — tenant isolation
  it("12.4.6.2.3: tenant isolation — Tenant A cannot consume Tenant B's quota", async () => {
    const path = "/api/v1/test-isolation";

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
      expect(r.allowed).toBe(true);
    }

    const rB = await checkRateLimit({ tenantId: fx.tenantId2, apiKeyId: fx.apiKeyIdB, path });
    expect(rB.allowed).toBe(true);
    expect(rB.remaining).toBeGreaterThan(0);

    await cleanScope(fx.apiKeyId);
    await cleanScope(fx.tenantId);
    await cleanScope(fx.apiKeyIdB);
    await cleanScope(fx.tenantId2);
  }, 30_000);

  // 12.4.6.2.4 — sensitive endpoint
  it("12.4.6.2.4: sensitive endpoint — lower limit enforced", async () => {
    const path = "/api/auth/login";
    const limit = SENSITIVE_ENDPOINT_LIMIT_PER_MINUTE;

    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
      expect(r.allowed).toBe(true);
    }

    const denied = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(limit);

    await cleanScope(`${fx.tenantId}:${path}`);
    await cleanScope(fx.apiKeyId);
    await cleanScope(fx.tenantId);
  }, 30_000);

  // 12.4.6.2.5 — 429 response shape
  it("12.4.6.2.5: denied response shape — limit, remaining, resetAt, scope", async () => {
    const path = "/api/v1/test-response-shape";
    const limit = DEFAULT_KEY_LIMIT_PER_MINUTE;

    for (let i = 0; i < limit; i++) {
      await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
    }

    const denied = await checkRateLimit({ tenantId: fx.tenantId, apiKeyId: fx.apiKeyId, path });
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(limit);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAt).toBeInstanceOf(Date);
    expect(denied.resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(denied.scope).toBe("key");

    await cleanScope(fx.apiKeyId);
    await cleanScope(fx.tenantId);
  }, 30_000);
});
