/**
 * Seed script — populates the database with development data.
 *
 *   1. Ensures default pricing rules.
 *  2. Synchronizes plans from the (mock) eSIM provider.
 *  3. Creates the PRIMARY admin (ekontetevi@gmail / Payswap123456).
 *  4. Creates demo accounts (customer + demo admin) for quick login.
 *
 * Run with: bun run db:seed
 */

import { db } from "../src/lib/db";
import { syncPlansFromProvider } from "../src/lib/plans/service";
import { ensureDefaultPricingRules } from "../src/lib/plans/pricing";
import { hashPassword } from "../src/lib/security";
import { logger } from "../src/lib/logger";

async function main() {
  logger.info("seed.start");

  // Pricing rules + plan sync.
  await ensureDefaultPricingRules();
  const syncResult = await syncPlansFromProvider();
  logger.info("seed.plans_synced", { ...syncResult });

  // --- Provider credit accounts ---
  // Airalo: $10,000 credit facility (1,000,000 minor units)
  await db.providerCreditAccount.upsert({
    where: { provider: "airalo" },
    update: {},
    create: {
      provider: "airalo",
      creditLimit: 1_000_000,
      currency: "USD",
      outstandingLiability: 0,
      pendingCommitments: 0,
      invoicedAmount: 0,
      paidAmount: 0,
    },
  });
  // Mock provider: same limit for dev
  await db.providerCreditAccount.upsert({
    where: { provider: "mock" },
    update: {},
    create: {
      provider: "mock",
      creditLimit: 1_000_000,
      currency: "USD",
    },
  });
  logger.info("seed.provider_credit_accounts_ready");

  // --- PRIMARY admin (non-demo) — the real operator account ---
  const primaryAdminEmail = "ekontetevi@gmail";
  const primaryAdminPassword = "Payswap123456";
  const primaryAdminHash = await hashPassword(primaryAdminPassword);
  await db.user.upsert({
    where: { email: primaryAdminEmail },
    update: { role: "admin", passwordHash: primaryAdminHash, isDemo: false },
    create: { email: primaryAdminEmail, name: "Ekonte Tevi", role: "admin", passwordHash: primaryAdminHash, emailVerified: new Date(), isDemo: false },
  });
  logger.info("seed.primary_admin_ready", { email: primaryAdminEmail });

  // --- Demo accounts (quick login, clearly marked) ---
  const demoCustomerEmail = "demo@esim.local";
  const demoCustomerHash = await hashPassword("demo12345");
  await db.user.upsert({
    where: { email: demoCustomerEmail },
    update: { isDemo: true },
    create: { email: demoCustomerEmail, name: "Demo Traveler", role: "customer", passwordHash: demoCustomerHash, emailVerified: new Date(), isDemo: true },
  });

  const demoAdminEmail = "admin@esim.local";
  const demoAdminHash = await hashPassword("admin12345");
  await db.user.upsert({
    where: { email: demoAdminEmail },
    update: { isDemo: true },
    create: { email: demoAdminEmail, name: "Demo Admin", role: "admin", passwordHash: demoAdminHash, emailVerified: new Date(), isDemo: true },
  });
  logger.info("seed.demo_accounts_ready");

  console.log("\n========================================");
  console.log("  Seed complete");
  console.log("========================================");
  console.log(`  Primary admin: ${primaryAdminEmail} / ${primaryAdminPassword}`);
  console.log(`  Demo customer: demo@esim.local / demo12345`);
  console.log(`  Demo admin:    admin@esim.local / admin12345`);
  console.log(`  Plans:         ${syncResult.total} (${syncResult.created} new, ${syncResult.updated} updated)`);
  console.log("========================================\n");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
