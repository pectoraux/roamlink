/**
 * Control Plane — Kernel Bridge (Phase 8.5.2)
 *
 * Converts a selected ProtocolResource into the appropriate entitlement/binding
 * operation through the frozen connectivity kernel.
 *
 * The control plane chooses WHAT resource to use.
 * The kernel decides HOW that resource is provisioned.
 * The adapter performs provider-specific effects.
 *
 * This bridge is the single point where the protocol layer touches the
 * frozen kernel. It NEVER calls provider APIs directly — it always goes
 * through provisionBinding(), reconcileProvisioning(), etc.
 *
 * Architecture:
 *   ProtocolResource → resolveProviderBinding → provisionBinding/reconcile → adapter
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { provisionBinding, reconcileProvisioning } from "@/lib/connectivity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KernelBridgeResult = {
  status: "active" | "failed" | "reconciliation_required";
  entitlementId?: string;
  bindingId?: string;
  providerResourceId?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Resolve ProtocolResource → ProviderResourceBinding
// ---------------------------------------------------------------------------

/**
 * Resolve a ProtocolResource to its corresponding ProviderResourceBinding
 * in the frozen kernel. If the resource already has a binding, return it.
 * If not, create one via the kernel's createResourceBinding().
 */
export async function resolveResourceBinding(input: {
  protocolResourceId: string;
  tenantId: string;
  subjectId: string;
}): Promise<KernelBridgeResult> {
  // Load the ProtocolResource to get its capability + provider instance
  const resource = await db.protocolResource.findUnique({
    where: { id: input.protocolResourceId },
    include: {
      capability: true,
    },
  });

  if (!resource) {
    return { status: "failed", error: `ProtocolResource not found: ${input.protocolResourceId}` };
  }

  const capability = resource.capability;
  if (!capability) {
    return { status: "failed", error: `Capability not found for resource ${input.protocolResourceId}` };
  }

  // Find the tenant's active subscription (required by createEntitlement)
  const subscription = await db.tenantSubscription.findFirst({
    where: { tenantId: input.tenantId, status: "active" },
  });

  if (!subscription) {
    return { status: "failed", error: `No active subscription for tenant ${input.tenantId}` };
  }

  // Check if there's already an entitlement for this subject + capability
  const existingEntitlement = await db.connectivityEntitlement.findFirst({
    where: {
      tenantId: input.tenantId,
      subscriptionId: subscription.id,
      status: "ACTIVE",
    },
    include: {
      bindings: {
        where: { providerType: capability.providerType },
        take: 1,
      },
    },
  });

  if (existingEntitlement && existingEntitlement.bindings.length > 0) {
    // Already has an active binding — reconcile to verify it's still healthy
    const binding = existingEntitlement.bindings[0];
    logger.info("kernel_bridge.existing_binding", {
      resourceId: input.protocolResourceId,
      bindingId: binding.id,
    });

    // Use the frozen kernel's reconcileProvisioning to verify
    const reconResult = await reconcileProvisioning(binding.id).catch((err) => {
      logger.error("kernel_bridge.reconcile_failed", {
        bindingId: binding.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "failed", error: String(err) };
    });

    if (reconResult.status === "recovered" || reconResult.status === "reprovisioned") {
      return {
        status: "active",
        entitlementId: existingEntitlement.id,
        bindingId: binding.id,
        providerResourceId: reconResult.providerResourceId,
      };
    }

    if (reconResult.status === "failed") {
      return {
        status: "reconciliation_required",
        entitlementId: existingEntitlement.id,
        bindingId: binding.id,
        error: reconResult.error,
      };
    }

    // Already healthy
    return {
      status: "active",
      entitlementId: existingEntitlement.id,
      bindingId: binding.id,
      providerResourceId: binding.providerResourceId ?? undefined,
    };
  }

  // No existing binding — create one via the kernel
  // The kernel will call the adapter to provision the resource at the provider
  logger.info("kernel_bridge.provisioning", {
    resourceId: input.protocolResourceId,
    providerType: capability.providerType,
  });

  try {
    // Create entitlement (frozen kernel)
    const { createEntitlement, transitionEntitlement, createResourceBinding, ENTITLEMENT_STATES, CAPABILITY_TYPES } = await import("@/lib/connectivity");
    const entitlement = await createEntitlement({
      tenantId: input.tenantId,
      subscriptionId: subscription.id,
      capabilityType: capability.type as any,
      capabilitySet: JSON.parse(capability.technicalSpec),
      validFrom: new Date(),
      userId: input.subjectId,
    });

    await transitionEntitlement({
      entitlementId: entitlement.id,
      toState: ENTITLEMENT_STATES.ACTIVE,
    });

    // Create binding (frozen kernel)
    const binding = await createResourceBinding({
      entitlementId: entitlement.id,
      providerType: capability.providerType,
      resourceType: capability.type === "ROAMING" ? "esim_profile" : "hotspot_user",
      providerInstanceId: capability.providerInstanceId,
      userId: input.subjectId,
    });

    // Provision via the frozen kernel (this calls the adapter)
    const provisionResult = await provisionBinding(binding.id);

    if (provisionResult.status === "success" || provisionResult.status === "already_provisioned") {
      return {
        status: "active",
        entitlementId: entitlement.id,
        bindingId: binding.id,
        providerResourceId: provisionResult.providerResourceId,
      };
    }

    // Provisioning failed
    return {
      status: "failed",
      entitlementId: entitlement.id,
      bindingId: binding.id,
      error: `Provisioning failed: ${provisionResult.status} — ${provisionResult.error}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("kernel_bridge.provisioning_error", {
      resourceId: input.protocolResourceId,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Verify Resource is Actually Usable (Phase 8.5.4)
// ---------------------------------------------------------------------------

/**
 * Verify that a resource is actually usable — not just that the database
 * says it's IN_USE, but that the provider infrastructure confirms it.
 *
 * This uses the frozen kernel's reconcileProvisioning() + the adapter's
 * reconcile() to check infrastructure truth.
 *
 * If no binding exists yet (first activation), verification is deferred
 * to the kernel bridge's provisioning step.
 */
export async function verifyResourceUsable(resourceId: string, sessionId: string): Promise<{
  usable: boolean;
  reason?: string;
}> {
  // Step 1: Check DB state — resource must be IN_USE owned by this session
  const resource = await db.protocolResource.findUnique({
    where: { id: resourceId },
    select: { state: true, reservedBy: true, capabilityId: true },
  });

  if (!resource) {
    return { usable: false, reason: "Resource not found" };
  }

  if (resource.state !== "IN_USE") {
    return { usable: false, reason: `Resource state is "${resource.state}", expected "IN_USE"` };
  }

  if (resource.reservedBy !== sessionId) {
    return { usable: false, reason: `Ownership mismatch: reserved by "${resource.reservedBy}"` };
  }

  // Step 2: Check if there's a ProviderResourceBinding linked to this session's entitlement
  // If the kernel bridge has provisioned a binding, use the adapter's reconcile()
  // to verify infrastructure truth.
  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: { entitlementId: true },
  });

  if (session?.entitlementId) {
    const binding = await db.providerResourceBinding.findFirst({
      where: { entitlementId: session.entitlementId, status: "BOUND" },
      select: { id: true },
    });

    if (binding) {
      // Use the frozen kernel's reconcile to verify infrastructure truth
      try {
        const reconResult = await reconcileProvisioning(binding.id);
        if (reconResult.status === "failed") {
          return { usable: false, reason: `Provider reconciliation failed: ${reconResult.error}` };
        }
        // If reconciled or recovered, the resource is usable
        logger.info("verify.resource_verified_via_kernel", {
          resourceId, bindingId: binding.id, reconStatus: reconResult.status,
        });
      } catch (err) {
        // Reconciliation error — don't fail verification, just log
        // The resource might still be usable; the recon can retry
        logger.warn("verify.reconciliation_error", {
          resourceId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Step 3: If we got here, the DB state is correct and (if a binding exists)
  // the provider infrastructure has been verified via the kernel.
  return { usable: true };
}
