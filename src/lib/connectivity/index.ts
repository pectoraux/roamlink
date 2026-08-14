/**
 * Phase 2C — Connectivity module barrel export.
 *
 * Re-exports the entitlement kernel, adapter contract, and provider registry.
 */

// Entitlement kernel
export {
  seedConnectivityCapabilities,
  createEntitlement,
  transitionEntitlement,
  listEntitlements,
  getEntitlement,
  createResourceBinding,
  transitionBinding,
  listResourceBindings,
  reconcileConnectivityEntitlements,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
} from "./entitlement";
export type {
  CapabilityType,
  EntitlementState,
  BindingState,
} from "./entitlement";

// Adapter contract
export type {
  ConnectivityProviderAdapter,
  ConnectivityEntitlementInput,
  ProviderResourceBindingInput,
  ProvisionResult,
  ActionResult,
  UsageMetrics,
  ReconciliationResult,
} from "./adapter";

// Provider registry
export {
  registerConnectivityProvider,
  getConnectivityProvider,
  requireConnectivityProvider,
  listRegisteredProviderTypes,
  isProviderRegistered,
} from "./registry";

// Mock provider (for development/testing)
export { mockConnectivityProvider, MockConnectivityProvider } from "./mock-provider";
