/**
 * Phase 4 — Reseller Markup Rules
 *
 * Determines the customer-facing price of a supplier offer by applying
 * the reseller's markup rules.
 *
 * Markup resolution order (most specific to least specific):
 *   1. ResellerMarkup with capabilityType + providerType + supplierId (most specific)
 *   2. ResellerMarkup with capabilityType + providerType
 *   3. ResellerMarkup with capabilityType + supplierId
 *   4. ResellerMarkup with capabilityType
 *   5. ResellerMarkup with providerType + supplierId
 *   6. ResellerMarkup with providerType
 *   7. ResellerMarkup with supplierId
 *   8. ResellerMarkup with all null (global default)
 *   9. Tenant.defaultMarkupPercent (fallback)
 *
 * The reseller's own infrastructure offers (supplierId = null) have no
 * markup — the reseller IS the supplier, so the customer price is set
 * directly on the offer.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkupInput = {
  tenantId: string;
  capabilityType: string;
  providerType: string;
  supplierId: string | null;
  wholesalePriceMinor: number;
};

export type MarkupResult = {
  customerPriceMinor: number;
  markupPercent: number;
  markupFixedMinor: number;
  source: string; // which rule was applied
};

// ---------------------------------------------------------------------------
// Calculate Customer Price with Markup
// ---------------------------------------------------------------------------

/**
 * Calculate the customer-facing price for a supplier offer by applying
 * the reseller's markup rules.
 *
 * For the reseller's own infrastructure (supplierId = null), the customer
 * price is set directly on the offer — no markup is applied.
 */
export async function calculateCustomerPrice(input: MarkupInput): Promise<MarkupResult> {
  // Own infrastructure — no markup
  if (!input.supplierId) {
    return {
      customerPriceMinor: input.wholesalePriceMinor,
      markupPercent: 0,
      markupFixedMinor: 0,
      source: "own_infrastructure",
    };
  }

  // Find the most specific markup rule
  const rule = await findMostSpecificMarkup(
    input.tenantId,
    input.capabilityType,
    input.providerType,
    input.supplierId,
  );

  if (!rule) {
    // Fallback: Tenant.defaultMarkupPercent
    const tenant = await db.tenant.findUnique({
      where: { id: input.tenantId },
      select: { defaultMarkupPercent: true },
    });

    const markupPercent = tenant?.defaultMarkupPercent ?? 0;
    const customerPriceMinor = Math.round(
      input.wholesalePriceMinor * (1 + markupPercent / 100),
    );

    return {
      customerPriceMinor,
      markupPercent,
      markupFixedMinor: 0,
      source: "tenant_default",
    };
  }

  // Apply the rule
  let customerPriceMinor: number;
  if (rule.markupPercent > 0) {
    customerPriceMinor = Math.round(
      input.wholesalePriceMinor * (1 + rule.markupPercent / 100),
    );
  } else {
    customerPriceMinor = input.wholesalePriceMinor + rule.markupFixedMinor;
  }

  logger.info("markup.applied", {
    tenantId: input.tenantId,
    supplierId: input.supplierId,
    wholesalePriceMinor: input.wholesalePriceMinor,
    customerPriceMinor,
    source: rule.source,
  });

  return {
    customerPriceMinor,
    markupPercent: rule.markupPercent,
    markupFixedMinor: rule.markupFixedMinor,
    source: rule.source,
  };
}

// ---------------------------------------------------------------------------
// Find the most specific markup rule
// ---------------------------------------------------------------------------

async function findMostSpecificMarkup(
  tenantId: string,
  capabilityType: string,
  providerType: string,
  supplierId: string,
): Promise<{ markupPercent: number; markupFixedMinor: number; source: string } | null> {
  // Query all markup rules for this tenant (there shouldn't be many)
  const rules = await db.resellerMarkup.findMany({
    where: { tenantId },
  });

  // Resolution order (most specific first)
  const resolutionOrder: Array<{
    capabilityType: string | null;
    providerType: string | null;
    supplierId: string | null;
    label: string;
  }> = [
    // Triple-scoped (most specific)
    { capabilityType, providerType, supplierId, label: "capability+provider+supplier" },
    // Double-scoped
    { capabilityType, providerType, supplierId: null, label: "capability+provider" },
    { capabilityType, providerType: null, supplierId, label: "capability+supplier" },
    { capabilityType: null, providerType, supplierId, label: "provider+supplier" },
    // Single-scoped
    { capabilityType, providerType: null, supplierId: null, label: "capability" },
    { capabilityType: null, providerType, supplierId: null, label: "provider" },
    { capabilityType: null, providerType: null, supplierId, label: "supplier" },
    // Global default
    { capabilityType: null, providerType: null, supplierId: null, label: "global" },
  ];

  for (const target of resolutionOrder) {
    const match = rules.find((r) =>
      r.capabilityType === target.capabilityType &&
      r.providerType === target.providerType &&
      r.supplierId === target.supplierId,
    );
    if (match) {
      return {
        markupPercent: match.markupPercent,
        markupFixedMinor: match.markupFixedMinor,
        source: target.label,
      };
    }
  }

  return null;
}
