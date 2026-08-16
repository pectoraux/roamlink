/**
 * Control Plane — Kernel Bridge (Phase 8.5.7)
 *
 * The single point where the protocol layer touches the frozen kernel.
 *
 * Fixes from Phase 8.5 audit:
 *   1. resolveResourceBinding() is now called by ACTIVATE/SWITCH (not just defined)
 *   2. Entitlement lookup is scoped by subjectId (fixes cross-user isolation)
 *   3. verifyResourceUsable() returns USABLE | NOT_USABLE | UNKNOWN (fail-closed)
 *   4. ProtocolResource → ProviderResourceBinding link is explicit
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
 * Resolve a ProtocolResource to its corresponding ProviderResourceBinding
 * in the frozen kernel. If the resource already has a linked binding, return it.
 * If not, create one via the kernel's createResourceBinding() + provisionBinding().
 *
 * Phase 8.5.7 fixes:
 *   - Entitlement lookup scoped by subjectId (prevents cross-user access)
 *   - ProtocolResource.providerBindingId link is checked/updated
 */
export async function resolveResourceBinding(input: {
  protocolResourceId: string;
  tenantId: string;
  subjectId: string;
}): Promise<KernelBridgeResult> {
  // Load the ProtocolResource to get its capability + provider instance + existing binding link
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

  // FIX 2: If the resource already has a linked binding, use it directly
  // This eliminates the identity ambiguity (ProtocolResource #17 → which binding?)
  if (resource.providerBindingId) {
    const existingBinding = await db.providerResourceBinding.findUnique({
      where: { id: resource.providerBindingId },
    });

    if (existingBinding) {
      logger.info("kernel_bridge.linked_binding", {
        resourceId: input.protocolResourceId,
        bindingId: existingBinding.id,
      });

      // Use the frozen kernel's reconcileProvisioning to verify
      try {
        const reconResult = await reconcileProvisioning(existingBinding.id);
        if (reconResult.status === "recovered" || reconResult.status === "reprovisioned" || reconResult.status === "already_healthy") {
          // Get the entitlement for this binding
          const entitlement = await db.connectivityEntitlement.findUnique({
            where: { id: existingBinding.entitlementId },
            select: { id: true },
          });
          return {
            status: "active",
            entitlementId: entitlement?.id,
            bindingId: existingBinding.id,
            providerResourceId: existingBinding.providerResourceId ?? reconResult.providerResourceId,
          };
        }
        if (reconResult.status === "failed") {
          return {
            status: "reconciliation_required",
            bindingId: existingBinding.id,
            error: reconResult.error,
          };
        }
        // recovered/reprovisioned → active
        return {
          status: "active",
          bindingId: existingBinding.id,
          providerResourceId: reconResult.providerResourceId ?? existingBinding.providerResourceId ?? undefined,
        };
      } catch (err) {
        return {
          status: "reconciliation_required",
          bindingId: existingBinding.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // No linked binding — find or create entitlement + binding
  const subscription = await db.tenantSubscription.findFirst({
    where: { tenantId: input.tenantId, status: "active" },
  });

  if (!subscription) {
    return { status: "failed", error: `No active subscription for tenant ${input.tenantId}` };
  }

  // FIX 3: Scope entitlement lookup by subjectId (userId) — prevents cross-user access
  const existingEntitlement = await db.connectivityEntitlement.findFirst({
    where: {
      tenantId: input.tenantId,
      subscriptionId: subscription.id,
      userId: input.subjectId, // CRITICAL: scope by user, not just tenant
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
    const binding = existingEntitlement.bindings[0];
    logger.info("kernel_bridge.existing_binding", {
      resourceId: input.protocolResourceId,
      bindingId: binding.id,
      subjectId: input.subjectId,
    });

    // Link the ProtocolResource to this binding for future lookups
    await db.protocolResource.update({
      where: { id: input.protocolResourceId },
      data: { providerBindingId: binding.id },
    }).catch(() => {}); // best-effort link

    try {
      const reconResult = await reconcileProvisioning(binding.id);
      if (reconResult.status === "failed") {
        return {
          status: "reconciliation_required",
          entitlementId: existingEntitlement.id,
          bindingId: binding.id,
          error: reconResult.error,
        };
      }
      return {
        status: "active",
        entitlementId: existingEntitlement.id,
        bindingId: binding.id,
        providerResourceId: reconResult.providerResourceId ?? binding.providerResourceId ?? undefined,
      };
    } catch (err) {
      return {
        status: "reconciliation_required",
        entitlementId: existingEntitlement.id,
        bindingId: binding.id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // No existing binding — create one via the kernel
  logger.info("kernel_bridge.provisioning", {
    resourceId: input.protocolResourceId,
    providerType: capability.providerType,
    subjectId: input.subjectId,
  });

  try {
    const { createEntitlement, transitionEntitlement, createResourceBinding, ENTITLEMENT_STATES } = await import("@/lib/connectivity");
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

    const binding = await createResourceBinding({
      entitlementId: entitlement.id,
      providerType: capability.providerType,
      resourceType: capability.type === "ROAMING" ? "esim_profile" : "hotspot_user",
      providerInstanceId: capability.providerInstanceId,
      userId: input.subjectId,
    });

    const provisionResult = await provisionBinding(binding.id);

    if (provisionResult.status === "success" || provisionResult.status === "already_provisioned") {
      // FIX 6: Link the ProtocolResource to the new binding
      await db.protocolResource.update({
        where: { id: input.protocolResourceId },
        data: { providerBindingId: binding.id },
      }).catch(() => {});

      return {
        status: "active",
        entitlementId: entitlement.id,
        bindingId: binding.id,
        providerResourceId: provisionResult.providerResourceId,
      };
    }

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
// Verify Resource is Actually Usable — fail-closed (Phase 8.5.7)
// ---------------------------------------------------------------------------

/**
 * Verify that a resource is actually usable.
 *
 * Phase 8.5.7: Returns USABLE | NOT_USABLE | UNKNOWN (not boolean).
 *   USABLE     → DB state correct + provider reconcile confirms
 *   NOT_USABLE → DB state wrong OR provider reconcile says failed
 *   UNKNOWN    → Provider reconciliation threw an error (fail-closed: don't assume usable)
 *
 * The action executor treats:
 *   USABLE     → continue
 *   NOT_USABLE → release + fail
 *   UNKNOWN    → mark RECONCILIATION_REQUIRED
 */
export async function verifyResourceUsable(resourceId: string, sessionId: string): Promise<VerificationResult> {
  // Step 1: Check DB state
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

  // Step 2: If the resource has a linked binding, verify via kernel reconcile
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
      // recovered / reprovisioned / already_healthy → USABLE
      logger.info("verify.resource_verified_via_kernel", {
        resourceId, bindingId: resource.providerBindingId, reconStatus: reconResult.status,
      });
      return { status: "USABLE", bindingId: resource.providerBindingId };
    } catch (err) {
      // FIX 4: Fail-closed — reconciliation error → UNKNOWN, not usable
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

  // Step 3: No linked binding — check via session entitlement
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
        // FIX 4: Fail-closed
        return {
          status: "UNKNOWN",
          reason: `Reconciliation error: ${err instanceof Error ? err.message : String(err)}`,
          bindingId: binding.id,
        };
      }
    }
  }

  // No binding exists — the bridge should have created one.
  // If we get here, the bridge wasn't called. Return UNKNOWN (fail-closed).
  return {
    status: "UNKNOWN",
    reason: "No provider binding linked to this resource — kernel bridge may not have been called",
  };
}
