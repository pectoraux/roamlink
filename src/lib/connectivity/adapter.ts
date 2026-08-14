/**
 * Phase 2C.1 — Connectivity Provider Adapter Contract
 *
 * This interface defines the contract that all connectivity provider adapters
 * (MikroTik, WiFi ISP, eSIM, etc.) must implement. It is provider-neutral —
 * the entitlement kernel calls this interface, never a specific provider.
 *
 * Carryover principle from SaaS hardening:
 *   "Every external side effect needs a durable state machine and reconciliation path."
 *
 * All operations MUST be idempotent. Provider APIs will retry — our system
 * must not create duplicate resources when the same operation is called twice.
 *
 * The adapter does NOT own financial state. It only manages infrastructure
 * resources. Financial truth is owned by the SaaS billing kernel (FROZEN).
 * Entitlement truth is owned by the Connectivity Entitlement Kernel.
 * Infrastructure truth is owned by the adapter + ProviderResourceBinding.
 */

// ---------------------------------------------------------------------------
// Entitlement/Binding type references (re-exported for adapter convenience)
// ---------------------------------------------------------------------------

export type ConnectivityEntitlementInput = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  status: string;
  capabilityType: string;
  capabilitySet: Record<string, unknown>;
  policy: Record<string, unknown> | null;
  validFrom: Date;
  validUntil: Date | null;
};

export type ProviderResourceBindingInput = {
  id: string;
  entitlementId: string;
  providerType: string;
  providerResourceId: string | null;
  providerMetadata: Record<string, unknown> | null;
  status: string;
  provisioningState: string | null;
};

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export type ProvisionResult = {
  status: "success" | "pending" | "failed_retryable" | "failed_permanent";
  providerResourceId?: string;
  providerMetadata?: Record<string, unknown>;
  error?: string;
};

export type ActionResult = {
  status: "success" | "pending" | "failed_retryable" | "failed_permanent";
  error?: string;
};

export type UsageMetrics = {
  downloadBytes?: number;
  uploadBytes?: number;
  totalBytes?: number;
  currentDownloadMbps?: number;
  currentUploadMbps?: number;
  sessionDurationSeconds?: number;
  isActive?: boolean;
  measuredAt?: Date;
};

// ---------------------------------------------------------------------------
// Provider Adapter Interface
// ---------------------------------------------------------------------------

export interface ConnectivityProviderAdapter {
  readonly providerType: string;
  readonly label: string;

  provision(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ProvisionResult>;

  suspend(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult>;

  resume(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult>;

  release(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult>;

  getUsage(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<UsageMetrics | undefined>;
}
