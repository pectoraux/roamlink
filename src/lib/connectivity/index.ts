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
  reconcileBindingWithProvider,
  claimProvisioning,
  provisionBinding,
  reconcileProvisioning,
  verifyProvisioningOwnership,
  extendProvisioningLease,
  _setHeartbeatIntervalForTesting,
  _setOperationTimeoutForTesting,
  _setLeaseDurationForTesting,
  createProviderInstance,
  listProviderInstances,
  getProviderInstance,
  resolveBindingWithInstance,
  resolveBindingRuntime,
  CAPABILITY_TYPES,
  ENTITLEMENT_STATES,
  BINDING_STATES,
} from "./entitlement";
export type {
  CapabilityType,
  EntitlementState,
  BindingState,
  ReconciliationResult as ProvisioningReconciliationResult,
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
  replaceConnectivityProvider,
  unregisterConnectivityProvider,
  getConnectivityProvider,
  requireConnectivityProvider,
  listRegisteredProviderTypes,
  isProviderRegistered,
  normalizeProviderType,
  resolveBindingAdapter,
} from "./registry";

// Mock provider (for development/testing)
export { mockConnectivityProvider, MockConnectivityProvider } from "./mock-provider";

// Phase 2C.3: MikroTik provider (reference implementation)
export { MikroTikConnectivityAdapter } from "./providers/mikrotik/adapter";
// The pre-instantiated adapter instance (registered with the provider registry).
// Tests import this to test the adapter directly without going through the registry.
export { mikrotikAdapter as mikrotikConnectivityAdapter } from "./providers/mikrotik";
export type { MikroTikProviderClient, MikroTikResource, MikroTikResourceConfig, MikroTikErrorType, MikroTikClientResolver } from "./providers/mikrotik/client";
export { MikroTikProviderError } from "./providers/mikrotik/client";
export { MockMikroTikProviderClient, mockMikroTikProviderClient, setMockFailureSimulation, clearMockFailureSimulation, clearMockMikroTikResources } from "./providers/mikrotik/mock-client";
export { registerMockClientForInstance, clearMockClientRegistry, clearClientCache, invalidateRouterOSClient, createRouterOSClientForInstance, productionAsyncResolver } from "./providers/mikrotik/client-factory";
export type { AsyncMikroTikClientResolver } from "./providers/mikrotik/client-factory";
export { RouterOSProviderClient } from "./providers/mikrotik/routeros-client";
export { FetchRouterOSTransport, MockRouterOSTransport } from "./providers/mikrotik/transport";
export type { RouterOSTransport, RouterOSTransportConfig } from "./providers/mikrotik/transport";
export { EnvProviderInstanceSecretResolver, TestSecretResolver } from "./providers/mikrotik/secret-resolver";
export type { ProviderInstanceSecretResolver, ResolvedProviderCredentials } from "./providers/mikrotik/secret-resolver";

// Phase 2C.5: eSIM supplier provider (first real connectivity supplier)
export { EsimConnectivityAdapter } from "./providers/esim/adapter";
export type { EsimProviderClient, EsimResource, EsimResourceConfig, EsimErrorType, EsimClientResolver, AsyncEsimClientResolver } from "./providers/esim/client";
export { EsimProviderError } from "./providers/esim/client";
export { registerMockEsimClientForInstance, clearEsimMockClientRegistry } from "./providers/esim/mock-client";
export { MockEsimTransport, FetchEsimTransport } from "./providers/esim/transport";
export type { EsimTransport, EsimTransportConfig } from "./providers/esim/transport";
export { EsimSupplierClient } from "./providers/esim/esim-client";

// Register both providers at module load time
import "./providers/mikrotik";
import "./providers/esim";
