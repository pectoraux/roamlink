/**
 * Catalog Identity — canonical product identity for connectivity products.
 *
 * A canonical connectivity product is identified by its NORMALIZED attributes
 * (type, country, data amount, validity), NOT by which supplier happens to
 * stock it. Two suppliers syncing the "Ghana 1GB / 7 Days" plan must converge
 * onto a single ConnectivityProduct row.
 *
 * The canonicalSpecification is a deterministic JSON string derived from the
 * product attributes. The identityHash is the SHA-256 of the canonical spec.
 * Suppliers and offers can change; the canonical product identity is stable.
 */

import { createHash } from "crypto";

export type ProductType =
  | "ESIM"
  | "VIRTUAL_NUMBER"
  | "WIFI"
  | "LOCAL_DATA"
  | "BUNDLE";

export type IdentityInput = {
  type: ProductType;
  name?: string;
  country?: string | null;
  countryCode?: string | null;
  region?: string | null;
  dataAmountMB?: number | null;
  validityDays?: number | null;
  capabilities?: string[] | null;
};

/**
 * Compute a canonical specification string for a connectivity product.
 * Attributes are normalized so that semantically-equivalent inputs produce
 * byte-identical specs (and therefore identical identityHashes).
 */
export function computeCanonicalSpec(input: IdentityInput): string {
  const normalized: Record<string, unknown> = {
    type: (input.type ?? "ESIM").toUpperCase(),
    country: normalizeString(input.country),
    countryCode: normalizeString(input.countryCode)?.toUpperCase() ?? null,
    region: normalizeString(input.region),
    dataAmountMB: normalizeInt(input.dataAmountMB),
    validityDays: normalizeInt(input.validityDays),
    capabilities: normalizeCapabilities(input.capabilities),
  };

  // Stable key ordering — JSON.stringify preserves insertion order for objects.
  return JSON.stringify(normalized);
}

/** Compute the SHA-256 identity hash of a canonical spec. */
export function computeIdentityHash(spec: string): string {
  return createHash("sha256").update(spec, "utf8").digest("hex");
}

/** Compute both the canonical spec and the identity hash in one call. */
export function computeProductIdentity(input: IdentityInput): {
  canonicalSpecification: string;
  identityHash: string;
} {
  const canonicalSpecification = computeCanonicalSpec(input);
  const identityHash = computeIdentityHash(canonicalSpecification);
  return { canonicalSpecification, identityHash };
}

function normalizeString(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInt(n: number | null | undefined): number | null {
  if (n == null) return null;
  const i = Math.round(Number(n));
  if (!Number.isFinite(i)) return null;
  return i;
}

function normalizeCapabilities(caps: string[] | null | undefined): string[] | null {
  if (!caps || caps.length === 0) return null;
  const normalized = caps
    .map((c) => String(c).trim().toUpperCase())
    .filter((c) => c.length > 0)
    .sort();
  return normalized.length > 0 ? normalized : null;
}
