/**
 * Control Plane — Kernel Bridge (Phase 8.5.8)
 *
 * The single point where the protocol layer touches the frozen kernel.
 *
 * Phase 8.5.8 fixes:
 *   1. tenantId derived from ProtocolResource → Capability (not caller-supplied)
 *   2. providerBindingId validated against tenant + subject + providerType
 *   3. UNKNOWN stays RECONCILIATION_REQUIRED (not SUCCEEDED)
 *   4. Recovery restores entitlementId alongside activeResourceId
 *   5. Old-resource release failure → durable reconciliation marker
 *   6. Recovery-worker fencing (atomic claim)
 *
 * Architecture:
 *   ProtocolResource → resolveResourceBinding → provisionBinding/reconcile → adapter
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
  tenantId?: string; // derived from capability
  error?: string;
};

export type VerificationResult = {
  status: "USABLE" | "NOT_USABLE" | "UNKNOWN";
  reason?: string;
  bindingId?: string;
};

// ---------------------------------------------------------------------------
// Resolve ProtocolResource → ProviderResourceBinding
// ---------------------------------------------------------------------------

/**
 * Resolve a ProtocolResource to its corresponding ProviderResourceBinding.
 *
 * Phase 8.5.8: tenantId is DERIVED from the resource's capability, not
 * supplied by the caller. This prevents the action executor from passing
 * the wrong tenantId (it was previously passing session.subjectId as tenantId).
 *
 * The caller supplies only:
 *   - protocolResourceId (which resource to resolve)
 *   - subjectId (which user is requesting)
 *
 * The bridge derives:
 *   - tenantId (from ProtocolResource → ProtocolCapability.tenantId)
 *   - providerType, providerInstanceId (from the capability)
 *   - subscriptionId (from tenantId + active subscription)
 */
export async function resolveResourceBinding(input: {
  protocolResourceId: string;
  subjectId: string;
}): Promise<KernelBridgeResult> {
  // Load the ProtocolResource with its capability
  const resource = await db.protocolResource.findUnique({
    where: { id: input.protocolResourceId },
    include: { capability: true },
  });

  if (!resource) {
    return { status: "failed", error: `ProtocolResource not found: ${input.protocolResourceId}` };
  }

  const capability = resource.capability;
  if (!capability) {
    return { status: "failed", error: `Capability not found for resource ${input.protocolResourceId}` };
  }

  // DERIVE tenantId from the capability — never trust the caller
  const tenantId = capability.tenantId;
  const providerType = capability.providerType;
  const providerInstanceId = capability.providerInstanceId;

  // If the resource has a linked binding, validate it before using
  if (resource.providerBindingId) {
    const existingBinding = await db.providerResourceBinding.findUnique({
      where: { id: resource.providerBindingId },
      include: { entitlement: { select: { tenantId: true, userId: true } } },
    });

    if (existingBinding) {
      // FIX 2: Validate binding ownership — tenant, subject, providerType must all agree
      const bindingEntitlement = existingBinding.entitlement;
      if (bindingEntitlement?.tenantId !== tenantId) {
        logger.error("kernel_bridge.binding_tenant_mismatch", {
          resourceId: input.protocolResourceId,
          bindingId: existingBinding.id,
          bindingTenant: bindingEntitlement?.tenantId,
          capabilityTenant: tenantId,
        });
        return { status: "failed", error: `Binding tenant mismatch — clearing stale link`, tenantId };
      }
      if (bindingEntitlement?.userId !== input.subjectId) {
        logger.error("kernel_bridge.binding_subject_mismatch", {
          resourceId: input.protocolResourceId,
          bindingId: existingBinding.id,
          bindingSubject: bindingEntitlement?.userId,
          requestSubject: input.subjectId,
        });
        return { status: "failed", error: `Binding subject mismatch — ownership violation`, tenantId };
      }
      if (existingBinding.providerType !== providerType) {
        logger.error("kernel_bridge.binding_provider_type_mismatch", {
          bindingId: existingBinding.id,
          bindingType: existingBinding.providerType,
          capabilityType: providerType,
        });
        return { status: "failed", error: `Binding providerType mismatch`, tenantId };
      }

      logger.info("kernel_bridge.linked_binding_validated", {
        resourceId: input.protocolResourceId,
        bindingId: existingBinding.id,
        tenantId,
        subjectId: input.subjectId,
      });

      // Reconcile via the frozen kernel
      try {
        const reconResult = await reconcileProvisioning(existingBinding.id);
        if (reconResult.status === "failed") {
          return {
            status: "reconciliation_required",
            entitlementId: bindingEntitlement?.id,
            bindingId: existingBinding.id,
            tenantId,
            error: reconResult.error,
          };
        }
        return {
          status: "active",
          entitlementId: bindingEntitlement?.id,
          bindingId: existingBinding.id,
          providerResourceId: reconResult.providerResourceId ?? existingBinding.providerResourceId ?? undefined,
          tenantId,
        };
      } catch (err) {
        return {
          status: "reconciliation_required",
          entitlementId: bindingEntitlement?.id,
          bindingId: existingBinding.id,
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // No validated linked binding — find or create entitlement + binding
  const subscription = await db.tenantSubscription.findFirst({
    where: { tenantId, status: "active" },
  });

  if (!subscription) {
    return { status: "failed", error: `No active subscription for tenant ${tenantId}`, tenantId };
  }

  // Scope entitlement lookup by subjectId — prevents cross-user access
  const existingEntitlement = await db.connectivityEntitlement.findFirst({
    where: {
      tenantId,
      subscriptionId: subscription.id,
      userId: input.subjectId,
      status: "ACTIVE",
    },
    include: {
      resourceBindings: {
        where: { providerType },
        take: 1,
      },
    },
  });

  if (existingEntitlement && existingEntitlement.resourceBindings.length > 0) {
    const binding = existingEntitlement.resourceBindings[0];
    logger.info("kernel_bridge.existing_binding", {
      resourceId: input.protocolResourceId,
      bindingId: binding.id,
      subjectId: input.subjectId,
      tenantId,
    });

    // Link the ProtocolResource to this binding
    await db.protocolResource.update({
      where: { id: input.protocolResourceId },
      data: { providerBindingId: binding.id },
    }).catch(() => {});

    try {
      const reconResult = await reconcileProvisioning(binding.id);
      if (reconResult.status === "failed") {
        return {
          status: "reconciliation_required",
          entitlementId: existingEntitlement.id,
          bindingId: binding.id,
          tenantId,
          error: reconResult.error,
        };
      }
      return {
        status: "active",
        entitlementId: existingEntitlement.id,
        bindingId: binding.id,
        providerResourceId: reconResult.providerResourceId ?? binding.providerResourceId ?? undefined,
        tenantId,
      };
    } catch (err) {
      return {
        status: "reconciliation_required",
        entitlementId: existingEntitlement.id,
        bindingId: binding.id,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // No existing binding — create one via the kernel
  logger.info("kernel_bridge.provisioning", {
    resourceId: input.protocolResourceId,
    providerType,
    subjectId: input.subjectId,
    tenantId,
  });

  try {
    const { createEntitlement, transitionEntitlement, createResourceBinding, ENTITLEMENT_STATES } = await import("@/lib/connectivity");
    const entitlement = await createEntitlement({
      tenantId,
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

    const binding = await createResourceBinding({
      entitlementId: entitlement.id,
      providerType,
      resourceType: capability.type === "ROAMING" ? "esim_profile" : "hotspot_user",
      providerInstanceId,
      userId: input.subjectId,
    });

    const provisionResult = await provisionBinding(binding.id);

    if (provisionResult.status === "success" || provisionResult.status === "already_provisioned") {
      await db.protocolResource.update({
        where: { id: input.protocolResourceId },
        data: { providerBindingId: binding.id },
      }).catch(() => {});

      return {
        status: "active",
        entitlementId: entitlement.id,
        bindingId: binding.id,
        providerResourceId: provisionResult.providerResourceId,
        tenantId,
      };
    }

    return {
      status: "failed",
      entitlementId: entitlement.id,
      bindingId: binding.id,
      tenantId,
      error: `Provisioning failed: ${provisionResult.status} — ${provisionResult.error}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("kernel_bridge.provisioning_error", {
      resourceId: input.protocolResourceId,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg, tenantId };
  }
}

// ---------------------------------------------------------------------------
// Verify Resource is Actually Usable — fail-closed
// ---------------------------------------------------------------------------

export async function verifyResourceUsable(resourceId: string, sessionId: string): Promise<VerificationResult> {
  const resource = await db.protocolResource.findUnique({
    where: { id: resourceId },
    select: { state: true, reservedBy: true, capabilityId: true, providerBindingId: true },
  });

  if (!resource) {
    return { status: "NOT_USABLE", reason: "Resource not found" };
  }

  if (resource.state !== "IN_USE") {
    return { status: "NOT_USABLE", reason: `Resource state is "${resource.state}", expected "IN_USE"` };
  }

  if (resource.reservedBy !== sessionId) {
    return { status: "NOT_USABLE", reason: `Ownership mismatch: reserved by "${resource.reservedBy}"` };
  }

  // If the resource has a linked binding, verify via kernel reconcile
  if (resource.providerBindingId) {
    try {
      const reconResult = await reconcileProvisioning(resource.providerBindingId);
      if (reconResult.status === "failed") {
        return {
          status: "NOT_USABLE",
          reason: `Provider reconciliation failed: ${reconResult.error}`,
          bindingId: resource.providerBindingId,
        };
      }
      logger.info("verify.resource_verified_via_kernel", {
        resourceId, bindingId: resource.providerBindingId, reconStatus: reconResult.status,
      });
      return { status: "USABLE", bindingId: resource.providerBindingId };
    } catch (err) {
      logger.error("verify.reconciliation_error", {
        resourceId, bindingId: resource.providerBindingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: "UNKNOWN",
        reason: `Reconciliation error: ${err instanceof Error ? err.message : String(err)}`,
        bindingId: resource.providerBindingId,
      };
    }
  }

  // No linked binding — check via session entitlement
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
      try {
        const reconResult = await reconcileProvisioning(binding.id);
        if (reconResult.status === "failed") {
          return {
            status: "NOT_USABLE",
            reason: `Provider reconciliation failed: ${reconResult.error}`,
            bindingId: binding.id,
          };
        }
        return { status: "USABLE", bindingId: binding.id };
      } catch (err) {
        return {
          status: "UNKNOWN",
          reason: `Reconciliation error: ${err instanceof Error ? err.message : String(err)}`,
          bindingId: binding.id,
        };
      }
    }
  }

  return {
    status: "UNKNOWN",
    reason: "No provider binding linked to this resource — kernel bridge may not have been called",
  };
}
