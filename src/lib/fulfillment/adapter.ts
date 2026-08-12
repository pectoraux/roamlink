/**
 * Fulfillment Adapter — the abstraction boundary between the orchestration
 * engine and the supplier-specific fulfillment mechanism.
 *
 * The orchestrator selects a Supplier (which carries a `providerKey`). The
 * fulfillment module resolves that key to a concrete FulfillmentAdapter that
 * knows how to talk to the supplier (e.g. the mock eSIM provider, Airalo,
 * a virtual-number API). The adapter produces a FulfillmentResult that is
 * then handed to a FulfillmentPersistenceHandler to be stored in the
 * appropriate domain table (Esim, VirtualNumber, ...).
 *
 * This indirection means:
 *   - The orchestrator never imports supplier-specific code.
 *   - The persistence layer is product-typed (Esim vs VirtualNumber vs ...)
 *     but the adapter is supplier-typed (mock vs airalo vs telnyx).
 *   - New product types can be added without touching the orchestrator.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { ProvisioningResult } from "@/types";

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type FulfillmentContext = {
  orderId: string;
  userId: string;
  productId: string;
  productType: string;
  sourcePlanId?: string | null;
  canonicalSpecification?: string | null;
  supplierOfferId: string;
  supplierId: string;
  supplierProductId?: string | null;
  providerKey: string;
  idempotencyKey: string;
};

export type FulfillmentResult = {
  externalReference: string;
  status: "success" | "pending" | "unknown";
  expiresAt?: string;
  metadata: Record<string, unknown>;
};

export interface FulfillmentAdapter {
  /** Stable key identifying this adapter (matches Supplier.providerKey). */
  readonly providerKey: string;

  /** Create the provider-side order and provision the product.
   * `supplierProductId` is the supplier-native product identifier (frozen at
   * selection time). It is NOT the Plan's providerPlanId — it comes from the
   * selected ConnectivityOffer.supplierProductId. */
  createProviderOrder(input: {
    context: FulfillmentContext;
    supplierProductId: string;
  }): Promise<{ providerOrderId: string }>;

  /** Provision the product (e.g. mint an eSIM, reserve a phone number). */
  provision(input: {
    context: FulfillmentContext;
    providerOrderId: string;
  }): Promise<FulfillmentResult>;

  /** Query the current status of a previously-initiated fulfillment. */
  getStatus(input: {
    context: FulfillmentContext;
    providerOrderId: string;
    externalReference: string;
  }): Promise<{ status: "success" | "pending" | "unknown"; metadata: Record<string, unknown> }>;

  /** Cancel a fulfillment where supported. */
  cancel(input: {
    context: FulfillmentContext;
    providerOrderId: string;
    externalReference: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Persistence contract
// ---------------------------------------------------------------------------

export interface FulfillmentPersistenceHandler {
  /** Product type this handler persists (e.g. "ESIM"). */
  readonly productType: string;

  /** Persist a fulfillment result onto the order. Returns the entity id. */
  persist(input: {
    context: FulfillmentContext;
    result: FulfillmentResult;
    providerOrderId: string;
  }): Promise<{ entityId: string }>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const adapterRegistry = new Map<string, FulfillmentAdapter>();
const persistenceRegistry = new Map<string, FulfillmentPersistenceHandler>();

export function registerAdapter(adapter: FulfillmentAdapter): void {
  adapterRegistry.set(adapter.providerKey, adapter);
}

export function getAdapter(providerKey: string): FulfillmentAdapter {
  const adapter = adapterRegistry.get(providerKey);
  if (!adapter) {
    throw new AppError(
      "not_found",
      `No fulfillment adapter registered for providerKey=${providerKey}`,
      500,
      "This supplier's fulfillment channel is not configured.",
    );
  }
  return adapter;
}

export function registerPersistenceHandler(handler: FulfillmentPersistenceHandler): void {
  persistenceRegistry.set(handler.productType, handler);
}

export function getPersistenceHandler(productType: string): FulfillmentPersistenceHandler {
  const handler = persistenceRegistry.get(productType);
  if (!handler) {
    throw new AppError(
      "not_found",
      `No persistence handler registered for productType=${productType}`,
      500,
      "This product type's persistence layer is not configured.",
    );
  }
  return handler;
}

/**
 * Resolve the providerKey for a supplier from the DB. Falls back to the
 * supplier's `name` lowercased if no explicit providerKey is set.
 */
export async function resolveProviderKey(supplierId: string): Promise<string> {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) {
    throw new AppError("not_found", `Supplier ${supplierId} not found`, 404, "Supplier not found.");
  }
  if (supplier.providerKey) return supplier.providerKey;
  return supplier.name.toLowerCase();
}

/**
 * Bridge a generic FulfillmentResult into the eSIM ProvisioningResult shape.
 * Only used internally by the ESIM adapter to keep the legacy provider API.
 */
export function toProvisioningResult(result: FulfillmentResult): Partial<ProvisioningResult> {
  return {
    providerESIMId: String(result.metadata.providerESIMId ?? result.externalReference),
    iccid: String(result.metadata.iccid ?? ""),
    smdpAddress: String(result.metadata.smdpAddress ?? ""),
    activationCode: String(result.metadata.activationCode ?? ""),
    matchId: result.metadata.matchId ? String(result.metadata.matchId) : undefined,
    dataAmountMB: Number(result.metadata.dataAmountMB ?? 0),
    validityDays: Number(result.metadata.validityDays ?? 0),
    expiresAt: result.expiresAt ?? new Date().toISOString(),
  };
}
