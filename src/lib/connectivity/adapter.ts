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
  /**
   * Phase 2C.3.2: The specific infrastructure instance this binding is
   * provisioned against. The adapter receives this through the generic
   * contract so it can resolve instance-specific configuration/credentials.
   *
   * providerType selects the adapter CLASS.
   * providerInstanceId selects the specific infrastructure INSTANCE.
   */
  providerInstanceId: string | null;
  /**
   * Phase 2C.3.2: Non-secret provider instance configuration (parsed from
   * ConnectivityProviderInstance.configuration JSON). The adapter may use
   * this to resolve endpoints, API versions, etc.
   */
  providerInstanceConfiguration: Record<string, unknown> | null;
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
// Reconciliation Result
// ---------------------------------------------------------------------------

/**
 * Result of a reconcile() call.
 *
 * The adapter compares the provider's observed state with the binding's
 * recorded state and reports whether they match or what action is needed.
 *
 * - in_sync: the provider's state matches the binding — no action needed
 * - drift_detected: the provider's state differs — the kernel should
 *   transition the binding (e.g., BOUND → DEGRADED if the resource is
 *   inactive at the provider)
 * - resource_missing: the provider no longer has the resource — the
 *   kernel should transition to FAILED and potentially re-provision
 * - failed_retryable: transient error checking the provider — retry later
 * - failed_permanent: permanent error — manual intervention required
 */
export type ReconciliationResult = {
  status: "in_sync" | "drift_detected" | "resource_missing" | "failed_retryable" | "failed_permanent";
  /** The provider's observed state for the resource (if available). */
  observedState?: "active" | "suspended" | "inactive" | "not_found";
  /** Recommended binding state transition (if drift detected). */
  recommendedBindingState?: string;
  /** Details about the drift or error. */
  details?: string;
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
    /** Phase 12.4.4a: Correlation context for operator observability. */
    correlation?: import("../observability/provider-correlation").ProviderCorrelationContext;
  }): Promise<ProvisionResult>;

  suspend(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
    correlation?: import("../observability/provider-correlation").ProviderCorrelationContext;
  }): Promise<ActionResult>;

  resume(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
    correlation?: import("../observability/provider-correlation").ProviderCorrelationContext;
  }): Promise<ActionResult>;

  release(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
    correlation?: import("../observability/provider-correlation").ProviderCorrelationContext;
  }): Promise<ActionResult>;

  getUsage(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
    correlation?: import("../observability/provider-correlation").ProviderCorrelationContext;
  }): Promise<UsageMetrics | undefined>;

  /**
   * Reconcile the binding's recorded state with the provider's observed state.
   *
   * Called by the reconciliation worker to detect drift. The adapter checks
   * the provider's API and reports whether the resource still exists, is
   * active, or has been modified.
   *
   * This is the connectivity equivalent of the SaaS reconciliation principle:
   * "Every external side effect needs a durable state machine and reconciliation path."
   *
   * Idempotent: calling reconcile() multiple times is safe.
   */
  reconcile(input: {
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
    correlation?: import("../observability/provider-correlation").ProviderCorrelationContext;
  }): Promise<ReconciliationResult>;
}
