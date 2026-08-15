/**
 * Phase 2C.5 — eSIM Supplier Client Interface
 *
 * This is the provider client for a real eSIM connectivity supplier (e.g.,
 * Airalo, Soracom, Truphone). It handles the supplier's REST API calls to
 * create, look up, suspend, resume, release, and measure eSIM profiles.
 *
 * This mirrors the MikroTik provider client structure exactly:
 *   - EsimResource.id = ICCID (the supplier-assigned profile identifier)
 *   - EsimResource.reference = the deterministic convergence key (like MikroTik username)
 *   - GET by reference for idempotency (like GET ?name= for MikroTik)
 *   - CONFLICT reconciliation on duplicate creation
 *
 * Resource identity:
 *   RoamLink providerResourceId = eSIM ICCID (supplier-assigned, immutable)
 *   reference = deterministic convergence key (derived from binding ID)
 *   GET by reference uses ?reference= query; GET/PATCH/DELETE by ICCID uses /{iccid}
 */

export type EsimErrorType =
  | "RETRYABLE"
  | "PERMANENT"
  | "AUTHENTICATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT";

export class EsimProviderError extends Error {
  constructor(
    public readonly errorType: EsimErrorType,
    message: string,
  ) {
    super(message);
    this.name = "EsimProviderError";
  }
}

/**
 * An eSIM profile at the supplier.
 *
 * id = ICCID (Integrated Circuit Card Identifier — the supplier-assigned,
 *   immutable profile identifier, used for GET/PATCH/DELETE addressing)
 * reference = the deterministic convergence key (set by RoamLink, used for
 *   lookup via ?reference= query and for idempotency)
 */
export type EsimResource = {
  /** ICCID — the supplier-assigned profile identifier (immutable) */
  id: string;
  /** The RoamLink reference (convergence key, derived from binding ID) */
  reference: string;
  /** Resource type: "esim_profile" */
  resourceType: string;
  /** Whether the profile is currently active/enabled */
  isActive: boolean;
  /** Data limit in bytes (0 = unlimited) */
  dataLimitBytes?: number;
  /** Data used so far in bytes */
  dataUsedBytes?: number;
  /** Countries allowed for roaming */
  allowedCountries?: string[];
  /** Validity period in days from activation */
  validityDays?: number;
  /** When the profile was created at the supplier */
  createdAt: Date;
};

/**
 * Configuration for creating an eSIM profile.
 */
export type EsimResourceConfig = {
  resourceType: string; // "esim_profile"
  reference: string;
  dataLimitBytes?: number;
  allowedCountries?: string[];
  validityDays?: number;
};

/**
 * The eSIM supplier provider client interface.
 */
export interface EsimProviderClient {
  createProfile(config: EsimResourceConfig): Promise<EsimResource>;
  getProfile(iccid: string): Promise<EsimResource | null>;
  suspendProfile(iccid: string): Promise<void>;
  resumeProfile(iccid: string): Promise<void>;
  releaseProfile(iccid: string): Promise<void>;
  getProfileUsage(iccid: string): Promise<{
    dataUsedBytes: number;
    dataLimitBytes: number;
    remainingBytes: number;
    isActive: boolean;
  } | null>;
}

export type EsimClientResolver = (input: {
  providerInstanceId: string;
  providerInstanceConfiguration: Record<string, unknown> | null;
}) => EsimProviderClient;

export type AsyncEsimClientResolver = (input: {
  providerInstanceId: string;
  providerInstanceConfiguration: Record<string, unknown> | null;
}) => Promise<EsimProviderClient>;
