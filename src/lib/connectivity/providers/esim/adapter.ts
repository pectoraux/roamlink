/**
 * Phase 2C.5 — eSIM Connectivity Adapter
 *
 * Implements the ConnectivityProviderAdapter contract for a real eSIM
 * connectivity supplier. Mirrors MikroTikConnectivityAdapter exactly.
 *
 * Architecture:
 *   ConnectivityProviderAdapter (generic contract — FROZEN)
 *     → EsimConnectivityAdapter (this file — translates contract to eSIM ops)
 *       → EsimSupplierClient (low-level supplier API)
 *
 * Capability mapping (ROAMING → eSIM config):
 *   allowedCountries → allowedCountries
 *   dataLimitBytes   → dataLimitBytes
 *   validityDays     → validityDays (default 30)
 *
 * The convergence key (reference) is derived deterministically from the
 * binding ID, exactly like MikroTik's username:
 *   reference = `rl-${binding.id.slice(-12)}`
 */

import type {
  ConnectivityProviderAdapter,
  ProvisionResult,
  ActionResult,
  UsageMetrics,
  ReconciliationResult,
  ConnectivityEntitlementInput,
  ProviderResourceBindingInput,
} from "../../adapter";
import type { EsimProviderClient, EsimResourceConfig, EsimClientResolver, AsyncEsimClientResolver } from "./client";
import { EsimProviderError } from "./client";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

function classifyError(err: unknown): {
  status: "failed_retryable" | "failed_permanent";
  error: string;
} {
  if (err instanceof EsimProviderError) {
    const permanent = ["PERMANENT", "AUTHENTICATION", "CONFLICT"];
    const retryable = ["RETRYABLE", "TIMEOUT"];
    if (permanent.includes(err.errorType)) {
      return { status: "failed_permanent", error: err.message };
    }
    if (retryable.includes(err.errorType)) {
      return { status: "failed_retryable", error: err.message };
    }
  }
  const errorMsg = err instanceof Error ? err.message : String(err);
  return { status: "failed_retryable", error: errorMsg };
}

// ---------------------------------------------------------------------------
// Capability Mapping
// ---------------------------------------------------------------------------

function mapCapabilityToEsimConfig(
  entitlement: ConnectivityEntitlementInput,
  binding: ProviderResourceBindingInput,
): EsimResourceConfig {
  const caps = entitlement.capabilitySet;
  const allowedCountries = (caps.allowedCountries as string[]) ?? [];
  const dataLimitBytes = (caps.dataLimitBytes as number) ?? 0;

  // Deterministic reference from the binding ID — same convergence key
  // pattern as MikroTik's username.
  const reference = `rl-${binding.id.slice(-12)}`;
  const resourceType = binding.resourceType ?? "esim_profile";

  return {
    resourceType,
    reference,
    dataLimitBytes: dataLimitBytes > 0 ? dataLimitBytes : 0,
    allowedCountries,
    validityDays: 30,
  };
}

// ---------------------------------------------------------------------------
// eSIM Connectivity Adapter
// ---------------------------------------------------------------------------

export class EsimConnectivityAdapter implements ConnectivityProviderAdapter {
  readonly providerType = "esim";
  readonly label = "eSIM Connectivity Supplier";

  constructor(
    private readonly clientResolver: EsimClientResolver | AsyncEsimClientResolver,
  ) {}

  private async resolveClient(binding: ProviderResourceBindingInput): Promise<EsimProviderClient> {
    const instanceId = binding.providerInstanceId;
    if (!instanceId) {
      throw new EsimProviderError("PERMANENT", "No providerInstanceId on binding — cannot resolve eSIM client");
    }
    const result = this.clientResolver({
      providerInstanceId: instanceId,
      providerInstanceConfiguration: binding.providerInstanceConfiguration,
    });
    return result instanceof Promise ? result : Promise.resolve(result);
  }

  async provision(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ProvisionResult> {
    try {
      const client = await this.resolveClient(input.binding);
      if (input.binding.providerResourceId) {
        const existing = await client.getProfile(input.binding.providerResourceId);
        if (existing) {
          logger.info("esim.provision_idempotent", {
            bindingId: input.binding.id, iccid: input.binding.providerResourceId,
          });
          return {
            status: "success",
            providerResourceId: existing.id,
            providerMetadata: {
              resourceType: existing.resourceType,
              isActive: existing.isActive,
              dataLimitBytes: existing.dataLimitBytes,
              allowedCountries: existing.allowedCountries,
            },
          };
        }
        logger.info("esim.provision_recreate", { bindingId: input.binding.id });
      }

      const config = mapCapabilityToEsimConfig(input.entitlement, input.binding);
      const resource = await client.createProfile(config);

      logger.info("esim.provisioned", {
        bindingId: input.binding.id, iccid: resource.id, reference: resource.reference,
      });

      return {
        status: "success",
        providerResourceId: resource.id,
        providerMetadata: {
          resourceType: resource.resourceType,
          isActive: resource.isActive,
          dataLimitBytes: resource.dataLimitBytes,
          allowedCountries: resource.allowedCountries,
        },
      };
    } catch (err) {
      const classified = classifyError(err);
      logger.error("esim.provision_failed", {
        bindingId: input.binding.id, error: classified.error, classification: classified.status,
      });
      return { status: classified.status, error: classified.error };
    }
  }

  async suspend(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    try {
      const client = await this.resolveClient(input.binding);
      if (!input.binding.providerResourceId) {
        return { status: "failed_permanent", error: "No providerResourceId on binding" };
      }
      await client.suspendProfile(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async resume(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    try {
      const client = await this.resolveClient(input.binding);
      if (!input.binding.providerResourceId) {
        return { status: "failed_permanent", error: "No providerResourceId on binding" };
      }
      await client.resumeProfile(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async release(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ActionResult> {
    try {
      const client = await this.resolveClient(input.binding);
      if (!input.binding.providerResourceId) {
        return { status: "success" };
      }
      await client.releaseProfile(input.binding.providerResourceId);
      return { status: "success" };
    } catch (err) {
      const classified = classifyError(err);
      return { status: classified.status, error: classified.error };
    }
  }

  async getUsage(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<UsageMetrics | undefined> {
    try {
      const client = await this.resolveClient(input.binding);
      if (!input.binding.providerResourceId) return undefined;
      const usage = await client.getProfileUsage(input.binding.providerResourceId);
      if (!usage) return undefined;
      return {
        downloadBytes: usage.dataUsedBytes,
        uploadBytes: 0,
        totalBytes: usage.dataUsedBytes,
        isActive: usage.isActive,
      };
    } catch {
      return undefined;
    }
  }

  async reconcile(input: {
    correlation?: any;
    entitlement: ConnectivityEntitlementInput;
    binding: ProviderResourceBindingInput;
  }): Promise<ReconciliationResult> {
    try {
      const client = await this.resolveClient(input.binding);
      if (!input.binding.providerResourceId) {
        return { status: "resource_missing", details: "No providerResourceId on binding" };
      }
      const existing = await client.getProfile(input.binding.providerResourceId);
      if (!existing) {
        return { status: "resource_missing", details: "eSIM profile not found at supplier" };
      }
      const expectedActive = input.binding.status === "BOUND";
      if (existing.isActive !== expectedActive) {
        return {
          status: "drift_detected",
          observedState: existing.isActive ? "active" : "suspended",
          recommendedBindingState: existing.isActive ? "BOUND" : "DEGRADED",
          details: `Profile is ${existing.isActive ? "active" : "suspended"} but binding is ${input.binding.status}`,
        };
      }
      return { status: "in_sync" };
    } catch (err) {
      const classified = classifyError(err);
      return {
        status: classified.status === "failed_retryable" ? "failed_retryable" : "failed_permanent",
        details: classified.error,
      };
    }
  }
}
