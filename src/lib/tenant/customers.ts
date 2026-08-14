/**
 * Tenant Customer service — CRUD for a reseller's customers.
 *
 * Phase 2B: A TenantCustomer is a reseller's customer, distinct from a
 * RoamLink User. It MAY link to a User account (for self-service) but can
 * also exist as a reseller-managed record.
 *
 * All operations are tenant-scoped: a tenant can only see/modify their own
 * customers. Cross-tenant access throws AppError(authorization).
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import { assertCanAddCustomer } from "./entitlements";

/** Create a customer for a tenant. */
export async function createTenantCustomer(input: {
  tenantId: string;
  name: string;
  email: string;
  phone?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; name: string; email: string; status: string }> {
  // Entitlement check
  await assertCanAddCustomer(input.tenantId);

  // Normalize email
  const email = input.email.trim().toLowerCase();

  // Check for duplicate within this tenant
  const existing = await db.tenantCustomer.findUnique({
    where: { tenantId_email: { tenantId: input.tenantId, email } },
  });
  if (existing) {
    throw new AppError("conflict", "Customer already exists", 409, "A customer with this email already exists in your tenant.");
  }

  const customer = await db.tenantCustomer.create({
    data: {
      tenantId: input.tenantId,
      name: input.name.trim(),
      email,
      phone: input.phone?.trim() || null,
      userId: input.userId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      status: "active",
    },
  });

  await audit({
    tenantId: input.tenantId,
    action: "tenant_customer.created",
    entity: "tenant_customer",
    entityId: customer.id,
    detail: { name: customer.name, email: customer.email },
  });
  logger.info("tenant_customer.created", { tenantId: input.tenantId, customerId: customer.id });
  return { id: customer.id, name: customer.name, email: customer.email, status: customer.status };
}

/** List customers for a tenant (with optional status filter). */
export async function listTenantCustomers(
  tenantId: string,
  opts?: { status?: string; limit?: number; offset?: number },
): Promise<Array<{ id: string; name: string; email: string; phone: string | null; status: string; userId: string | null; createdAt: Date }>> {
  return db.tenantCustomer.findMany({
    where: { tenantId, ...(opts?.status ? { status: opts.status } : {}) },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      status: true,
      userId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: opts?.limit ?? 50,
    skip: opts?.offset ?? 0,
  });
}

/** Get a single customer. Throws if it belongs to a different tenant. */
export async function getTenantCustomer(tenantId: string, customerId: string) {
  const customer = await db.tenantCustomer.findUnique({
    where: { id: customerId },
  });
  if (!customer) {
    throw new AppError("not_found", "Customer not found", 404, "Customer not found.");
  }
  if (customer.tenantId !== tenantId) {
    throw new AppError("authorization", "Cross-tenant access denied", 403, "You don't have access to this customer.");
  }
  return customer;
}

/** Update a customer. */
export async function updateTenantCustomer(
  tenantId: string,
  customerId: string,
  input: { name?: string; phone?: string; status?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  // Verify ownership
  await getTenantCustomer(tenantId, customerId);

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.phone !== undefined) data.phone = input.phone?.trim() || null;
  if (input.status !== undefined) data.status = input.status;
  if (input.metadata !== undefined) data.metadata = JSON.stringify(input.metadata);

  await db.tenantCustomer.update({ where: { id: customerId }, data });

  await audit({
    tenantId,
    action: "tenant_customer.updated",
    entity: "tenant_customer",
    entityId: customerId,
    detail: input,
  });
}

/** Get customer statistics for a tenant. */
export async function getTenantCustomerStats(tenantId: string): Promise<{
  total: number;
  active: number;
  suspended: number;
  cancelled: number;
}> {
  const [total, active, suspended, cancelled] = await Promise.all([
    db.tenantCustomer.count({ where: { tenantId } }),
    db.tenantCustomer.count({ where: { tenantId, status: "active" } }),
    db.tenantCustomer.count({ where: { tenantId, status: "suspended" } }),
    db.tenantCustomer.count({ where: { tenantId, status: "cancelled" } }),
  ]);
  return { total, active, suspended, cancelled };
}
