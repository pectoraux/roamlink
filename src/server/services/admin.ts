/**
 * Admin service — aggregate stats and management operations.
 */

import { db } from "@/lib/db";
import { syncPlansFromProvider } from "@/lib/plans/service";

export type AdminStats = {
  totalUsers: number;
  totalOrders: number;
  revenueMinor: number;
  revenueCurrency: string;
  successfulOrders: number;
  failedOrders: number;
  activeESIMs: number;
  totalESIMs: number;
  totalPlans: number;
  activePlans: number;
};

export async function getAdminStats(): Promise<AdminStats> {
  const [totalUsers, totalOrders, successfulOrders, failedOrders, activeESIMs, totalESIMs, totalPlans, activePlans] = await Promise.all([
    db.user.count({ where: { role: "customer" } }),
    db.order.count(),
    db.order.count({ where: { status: "COMPLETED" } }),
    db.order.count({ where: { status: { in: ["PAYMENT_FAILED", "PROVISIONING_FAILED", "CANCELLED"] } } }),
    db.esim.count({ where: { status: "active" } }),
    db.esim.count(),
    db.plan.count(),
    db.plan.count({ where: { status: "active" } }),
  ]);

  // Revenue = sum of succeeded payments.
  const revenueAgg = await db.payment.aggregate({ _sum: { amount: true }, where: { status: "succeeded" } });
  const revenueMinor = revenueAgg._sum.amount ?? 0;

  return {
    totalUsers,
    totalOrders,
    revenueMinor,
    revenueCurrency: "USD",
    successfulOrders,
    failedOrders,
    activeESIMs,
    totalESIMs,
    totalPlans,
    activePlans,
  };
}

export async function adminListOrders(opts: { search?: string; status?: string; limit?: number; offset?: number } = {}) {
  const where: Record<string, unknown> = {};
  if (opts.status) where.status = opts.status;
  const orders = await db.order.findMany({
    where,
    include: { plan: true, user: { select: { id: true, email: true, name: true } }, esim: true },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    skip: opts.offset ?? 0,
  });
  let result = orders;
  if (opts.search) {
    const q = opts.search.toLowerCase();
    result = orders.filter(
      (o) => o.id.toLowerCase().includes(q) || o.user.email.toLowerCase().includes(q) || (o.providerOrderId ?? "").toLowerCase().includes(q),
    );
  }
  return result;
}

export async function adminListESIMs(opts: { search?: string; status?: string } = {}) {
  const where: Record<string, unknown> = {};
  if (opts.status) where.status = opts.status;
  const esims = await db.esim.findMany({
    where,
    include: { user: { select: { id: true, email: true, name: true } }, order: { select: { id: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  let result = esims;
  if (opts.search) {
    const q = opts.search.toLowerCase();
    result = esims.filter((e) => (e.iccid ?? "").toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  }
  return result;
}

export async function adminListUsers() {
  return db.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true, _count: { select: { orders: true, esims: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function adminUpdatePlanStatus(planId: string, status: "active" | "inactive") {
  return db.plan.update({ where: { id: planId }, data: { status } });
}

export async function adminUpdatePlanPrice(planId: string, priceMinor: number) {
  return db.plan.update({ where: { id: planId }, data: { price: priceMinor } });
}

export async function adminSyncPlans() {
  return syncPlansFromProvider();
}

export function providerStatus() {
  return {
    esim: {
      id: process.env.ESIM_PROVIDER || "mock",
      configured: !!process.env.ESIM_PROVIDER,
      hasApiUrl: !!process.env.ESIM_API_URL,
      hasApiKey: !!process.env.ESIM_API_KEY,
    },
    payment: {
      id: process.env.PAYMENT_PROVIDER || "mock",
      configured: !!process.env.PAYMENT_PROVIDER,
      hasApiUrl: !!process.env.PAYMENT_API_URL,
      hasApiKey: !!process.env.PAYMENT_API_KEY,
    },
  };
}
