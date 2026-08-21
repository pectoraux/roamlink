/**
 * Phase 12.4.6.3 — Neon PostgreSQL Smoke Test.
 *
 * TEST CLASS: DB-AUTHORITY (smoke)
 *
 * Verifies the basic PostgreSQL connection + DB-authoritative primitives work
 * against the canonical Neon database. This is a SMOKE test — it proves the
 * runtime connection and the core semantics, NOT the full concurrency matrix
 * (see tests/phase12.4.6.3.1-postgres-concurrency-matrix.test.ts for that).
 *
 * Proves:
 *   1. Connection: Prisma can reach Neon PostgreSQL.
 *   2. CRUD: create/read/update/delete works.
 *   3. Transaction: $transaction with update works.
 *   4. Fenced updateMany: WHERE guard works (count=1 on match, count=0 on stale).
 *   5. Unique constraint: P2002 enforced on duplicate.
 *   6. FOR UPDATE: row-level lock works (PostgreSQL-specific).
 *
 * Run: bun test tests/phase12.4.6.3-neon-smoke.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { hashPassword } from "@/lib/security";
import { assertPostgres, uniqueTestSlug } from "./db-test-env";

describe("Phase 12.4.6.3 — Neon PostgreSQL Smoke", () => {
  beforeAll(() => {
    assertPostgres();
  }, 30_000);

  // 1. Connection + CRUD
  it(
    "smoke.1: connection + CRUD works against Neon PostgreSQL",
    async () => {
      const email = `smoke-${uniqueTestSlug("crud")}@test.roamlink`;
      const user = await db.user.create({
        data: {
          email,
          name: "Smoke CRUD",
          passwordHash: await hashPassword("test12345"),
          role: "customer",
          emailVerified: new Date(),
        },
      });

      // Read.
      const found = await db.user.findUnique({ where: { id: user.id } });
      expect(found).not.toBeNull();
      expect(found?.email).toBe(email);

      // Update.
      await db.user.update({
        where: { id: user.id },
        data: { name: "Smoke CRUD Updated" },
      });
      const updated = await db.user.findUnique({ where: { id: user.id } });
      expect(updated?.name).toBe("Smoke CRUD Updated");

      // Delete.
      await db.user.delete({ where: { id: user.id } });
      const deleted = await db.user.findUnique({ where: { id: user.id } });
      expect(deleted).toBeNull();
    },
    60_000,
  );

  // 2. Transaction
  it(
    "smoke.2: $transaction with update works",
    async () => {
      const email = `smoke-${uniqueTestSlug("tx")}@test.roamlink`;
      const user = await db.user.create({
        data: {
          email,
          name: "Smoke TX",
          passwordHash: "x",
          role: "customer",
          emailVerified: new Date(),
        },
      });

      try {
        const result = await db.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { name: "Smoke TX Updated" },
          });
          const u = await tx.user.findUnique({ where: { id: user.id } });
          return u?.name;
        });

        expect(result).toBe("Smoke TX Updated");

        // Verify outside the transaction.
        const after = await db.user.findUnique({ where: { id: user.id } });
        expect(after?.name).toBe("Smoke TX Updated");
      } finally {
        await db.user.delete({ where: { id: user.id } }).catch(() => {});
      }
    },
    60_000,
  );

  // 3. Fenced updateMany (WHERE guard)
  it(
    "smoke.3: fenced updateMany — WHERE guard works (match vs stale)",
    async () => {
      const session = await db.connectivitySession.create({
        data: {
          subjectId: `smoke-subject-${uniqueTestSlug("s")}`,
          state: "PLANNED",
        },
      });

      try {
        // Match: WHERE id matches + state=PLANNED → count=1.
        const matchResult = await db.connectivitySession.updateMany({
          where: { id: session.id, state: "PLANNED" },
          data: { state: "EXECUTING" },
        });
        expect(matchResult.count).toBe(1);

        // Stale: WHERE id matches + state=PLANNED (but it's now EXECUTING) → count=0.
        const staleResult = await db.connectivitySession.updateMany({
          where: { id: session.id, state: "PLANNED" },
          data: { state: "COMPLETED" },
        });
        expect(staleResult.count).toBe(0);

        // Verify the state is still EXECUTING (stale update was rejected).
        const after = await db.connectivitySession.findUnique({
          where: { id: session.id },
          select: { state: true },
        });
        expect(after?.state).toBe("EXECUTING");
      } finally {
        await db.connectivitySession
          .deleteMany({ where: { id: session.id } })
          .catch(() => {});
      }
    },
    60_000,
  );

  // 4. Unique constraint (P2002)
  it(
    "smoke.4: unique constraint — P2002 on duplicate email",
    async () => {
      const email = `smoke-${uniqueTestSlug("p2002")}@test.roamlink`;
      const user = await db.user.create({
        data: {
          email,
          name: "Smoke P2002 First",
          passwordHash: "x",
          role: "customer",
          emailVerified: new Date(),
        },
      });

      try {
        // Duplicate email → P2002.
        let p2002Caught = false;
        try {
          await db.user.create({
            data: {
              email,
              name: "Smoke P2002 Second",
              passwordHash: "x",
              role: "customer",
              emailVerified: new Date(),
            },
          });
        } catch (err: any) {
          if (err?.code === "P2002") {
            p2002Caught = true;
          }
        }
        expect(p2002Caught).toBe(true);

        // Verify only one row exists.
        const rows = await db.user.findMany({ where: { email } });
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Smoke P2002 First");
      } finally {
        await db.user.deleteMany({ where: { email } }).catch(() => {});
      }
    },
    60_000,
  );

  // 5. FOR UPDATE (PostgreSQL row-level lock)
  it(
    "smoke.5: FOR UPDATE row-level lock works (PostgreSQL-specific)",
    async () => {
      // This test verifies that SELECT ... FOR UPDATE executes without error
      // on PostgreSQL. (SQLite would throw a syntax error — proving this runs
      // on PostgreSQL.) The query runs inside a transaction and is rolled back
      // immediately — it proves the lock primitive is available without
      // depending on any pre-existing data.
      const result = await db.$transaction(async (tx) => {
        const rows: Array<{ id: string }> = await tx.$queryRaw`
          SELECT id FROM "ProviderResourceBinding" LIMIT 1 FOR UPDATE
        `;
        return Array.isArray(rows);
      });
      expect(result).toBe(true);
    },
    60_000,
  );
});
