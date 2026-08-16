/**
 * Control Plane — Active Connectivity Invariant Checker (Phase 8.5.9)
 *
 * A reusable invariant checker that verifies the complete identity chain
 * for an ACTIVE session:
 *
 *   ACTIVE session
 *       => activeResource exists
 *       => resource state = IN_USE
 *       => resource.reservedBy = session.id
 *       => resource has linked providerBindingId
 *       => binding.entitlement.userId = session.subjectId
 *       => binding.entitlement.tenantId = capability.tenantId
 *       => provider reconciliation = USABLE
 *
 * Called in:
 *   - normal ACTIVATE completion
 *   - normal SWITCH completion
 *   - recovery completion
 *   - reconciliation completion
 *
 * This prevents the normal and recovery paths from drifting apart.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { verifyResourceUsable } from "./kernel-bridge";

export type InvariantResult = {
  valid: boolean;
  violations: string[];
  sessionId: string;
  activeResourceId?: string;
  entitlementId?: string;
  bindingId?: string;
};

/**
 * Assert the active connectivity invariant for a session.
 *
 * If the session is ACTIVE, the entire chain must hold:
 *   session → resource → binding → entitlement → provider truth
 *
 * If any link is broken, the invariant returns { valid: false, violations: [...] }
 * but does NOT mutate state. The caller decides what to do (mark RECONCILIATION_REQUIRED,
 * transition to DEGRADED, etc.).
 */
export async function assertActiveConnectivityInvariant(sessionId: string): Promise<InvariantResult> {
  const violations: string[] = [];

  const session = await db.connectivitySession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      subjectId: true,
      state: true,
      activeResourceId: true,
      entitlementId: true,
    },
  });

  if (!session) {
    return { valid: false, violations: ["Session not found"], sessionId };
  }

  // If session is not ACTIVE, the invariant doesn't apply
  if (session.state !== "ACTIVE") {
    return { valid: true, violations: [], sessionId: session.id };
  }

  // 1. activeResourceId must exist
  if (!session.activeResourceId) {
    violations.push("ACTIVE session has no activeResourceId");
    return { valid: false, violations, sessionId: session.id };
  }

  // 2. Resource must exist and be IN_USE owned by this session
  const resource = await db.protocolResource.findUnique({
    where: { id: session.activeResourceId },
    select: { state: true, reservedBy: true, providerBindingId: true, capabilityId: true },
  });

  if (!resource) {
    violations.push(`Resource not found: ${session.activeResourceId}`);
    return { valid: false, violations, sessionId: session.id, activeResourceId: session.activeResourceId };
  }

  if (resource.state !== "IN_USE") {
    violations.push(`Resource state is "${resource.state}", expected "IN_USE"`);
  }

  if (resource.reservedBy !== session.id) {
    violations.push(`Resource reservedBy is "${resource.reservedBy}", expected "${session.id}"`);
  }

  // 3. Resource must have a linked binding
  if (!resource.providerBindingId) {
    violations.push("Resource has no linked providerBindingId");
  } else {
    // 4. Binding must exist and entitlement must belong to the session's subject
    const binding = await db.providerResourceBinding.findUnique({
      where: { id: resource.providerBindingId },
      include: {
        entitlement: { select: { id: true, userId: true, tenantId: true } },
      },
    });

    if (!binding) {
      violations.push(`Binding not found: ${resource.providerBindingId}`);
    } else {
      if (binding.entitlement?.userId !== session.subjectId) {
        violations.push(`Binding entitlement userId is "${binding.entitlement?.userId}", expected "${session.subjectId}"`);
      }

      // 5. Capability tenantId must match entitlement tenantId
      const capability = await db.protocolCapability.findUnique({
        where: { id: resource.capabilityId },
        select: { tenantId: true, providerType: true },
      });

      if (capability?.tenantId !== binding.entitlement?.tenantId) {
        violations.push(`Capability tenantId "${capability?.tenantId}" != entitlement tenantId "${binding.entitlement?.tenantId}"`);
      }

      if (binding.providerType !== capability?.providerType) {
        violations.push(`Binding providerType "${binding.providerType}" != capability providerType "${capability?.providerType}"`);
      }

      // 6. Session entitlementId must match binding entitlement
      if (session.entitlementId !== binding.entitlementId) {
        violations.push(`Session entitlementId "${session.entitlementId}" != binding entitlementId "${binding.entitlementId}"`);
      }

      // 7. Provider verification (USABLE | NOT_USABLE | UNKNOWN)
      const verifyResult = await verifyResourceUsable(session.activeResourceId, session.id);
      if (verifyResult.status !== "USABLE") {
        violations.push(`Provider verification: ${verifyResult.status} — ${verifyResult.reason}`);
      }

      return {
        valid: violations.length === 0,
        violations,
        sessionId: session.id,
        activeResourceId: session.activeResourceId,
        entitlementId: binding.entitlementId,
        bindingId: binding.id,
      };
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    sessionId: session.id,
    activeResourceId: session.activeResourceId,
    entitlementId: session.entitlementId ?? undefined,
  };
}
