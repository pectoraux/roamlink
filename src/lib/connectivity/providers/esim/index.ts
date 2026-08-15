/**
 * Phase 2C.5 — eSIM Supplier Provider Registration
 *
 * Registers the eSIM connectivity adapter with the provider registry.
 * The adapter receives the production async resolver (same pattern as MikroTik).
 *
 * This proves the architecture is supplier-neutral: the SAME kernel
 * (provisionBinding, claimProvisioning, reconcileProvisioning, lease,
 * heartbeat, convergence) works for BOTH MikroTik and eSIM without any
 * kernel changes — only a new adapter implementation.
 */

import { registerConnectivityProvider } from "../../registry";
import { EsimConnectivityAdapter } from "./adapter";
import { esimProductionAsyncResolver } from "./mock-client";

export { registerMockEsimClientForInstance, clearEsimMockClientRegistry } from "./mock-client";
export { MockEsimTransport, FetchEsimTransport } from "./transport";
export { EsimSupplierClient } from "./esim-client";
export type { EsimProviderClient, EsimResource, EsimResourceConfig, EsimErrorType, EsimClientResolver, AsyncEsimClientResolver } from "./client";
export { EsimProviderError } from "./client";

// Register the eSIM adapter with the production async resolver.
const esimAdapter = new EsimConnectivityAdapter(esimProductionAsyncResolver);
registerConnectivityProvider(esimAdapter);
