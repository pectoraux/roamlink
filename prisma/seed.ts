/**
 * Seed script — populates the database with development data.
 *
 *   1. Ensures default pricing rules.
 *   2. Synchronizes plans from the (mock) eSIM provider.
 *   3. Creates an admin user (ADMIN_EMAIL / ADMIN_PASSWORD).
 *   4. Creates a demo customer account.
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

  // Admin user.
  const adminEmail = process.env.ADMIN_EMAIL || "admin@esim.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin12345";
  const adminHash = await hashPassword(adminPassword);
  await db.user.upsert({
    where: { email: adminEmail },
    update: { role: "admin", passwordHash: adminHash },
    create: { email: adminEmail, name: "Admin", role: "admin", passwordHash: adminHash, emailVerified: new Date() },
  });
  logger.info("seed.admin_ready", { email: adminEmail });

  // Demo customer.
  const customerEmail = "demo@esim.local";
  const customerHash = await hashPassword("demo12345");
  await db.user.upsert({
    where: { email: customerEmail },
    update: {},
    create: { email: customerEmail, name: "Demo Traveler", role: "customer", passwordHash: customerHash, emailVerified: new Date() },
  });
  logger.info("seed.customer_ready", { email: customerEmail });

  console.log("\n========================================");
  console.log("  Seed complete");
  console.log("========================================");
  console.log(`  Admin:    ${adminEmail} / ${adminPassword}`);
  console.log(`  Customer: ${customerEmail} / demo12345`);
  console.log(`  Plans:    ${syncResult.total} (${syncResult.created} new, ${syncResult.updated} updated)`);
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
