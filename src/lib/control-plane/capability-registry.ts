/**
 * Control Plane — Capability Registry v2 (Phase 8.3)
 *
 * Uses first-class ProtocolCapability + ProtocolResource models instead of
 * reusing ConnectivityOffer2 with zero pricing. This correctly separates:
 *
 *   ProtocolCapability = what CAN be provided (technical supply)
 *   ProtocolResource   = what ACTUALLY EXISTS (allocatable instance)
 *   ConnectivityOffer2 = commercial realization (price + terms)
 *
 * Relationship: Capability → Resources → Offers
 *
 * A provider advertises a capability (technical supply). Resources are
 * concrete instances (hotspot APs, eSIM profiles). Offers are the
 * commercial packaging of capabilities with pricing.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Advertise a Capability (first-class model)
// ---------------------------------------------------------------------------

export async function advertiseCapability(input: {
  tenantId: string;
  providerInstanceId: string;
  type: string;
  providerType: string;
  technicalSpec: Record<string, unknown>;
  coverage: Record<string, unknown>;
  reliability?: number;
  validUntil?: Date;
}): Promise<{ capabilityId: string }> {
  const capability = await db.protocolCapability.create({
    data: {
      tenantId: input.tenantId,
      providerInstanceId: input.providerInstanceId,
      type: input.type,
      providerType: input.providerType,
      technicalSpec: JSON.stringify(input.technicalSpec),
      coverage: JSON.stringify(input.coverage),
      reliability: input.reliability ?? 0.5,
      status: "active",
      validUntil: input.validUntil ?? null,
    },
  });

  logger.info("capability.advertised_v2", {
    capabilityId: capability.id,
    tenantId: input.tenantId,
    type: input.type,
    providerType: input.providerType,
  });

  return { capabilityId: capability.id };
}

// ---------------------------------------------------------------------------
// Register a Resource (concrete allocatable instance)
// ---------------------------------------------------------------------------

export async function registerResource(input: {
  capabilityId: string;
  providerInstanceId: string;
  identifiers?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
  location?: Record<string, unknown>;
}): Promise<{ resourceId: string }> {
  const resource = await db.protocolResource.create({
    data: {
      capabilityId: input.capabilityId,
      providerInstanceId: input.providerInstanceId,
      identifiers: input.identifiers ? JSON.stringify(input.identifiers) : null,
      capacity: input.capacity ? JSON.stringify(input.capacity) : null,
      location: input.location ? JSON.stringify(input.location) : null,
      state: "AVAILABLE",
    },
  });

  logger.info("resource.registered", {
    resourceId: resource.id,
    capabilityId: input.capabilityId,
  });

  return { resourceId: resource.id };
}

// ---------------------------------------------------------------------------
// Discover Capabilities
// ---------------------------------------------------------------------------

export async function discoverCapabilities(input: {
  tenantId: string;
  type?: string;
  country?: string;
  city?: string;
  minReliability?: number;
}): Promise<Array<{
  id: string;
  type: string;
  providerType: string;
  technicalSpec: Record<string, unknown>;
  coverage: Record<string, unknown>;
  reliability: number;
  resourceCount: number;
}>> {
  const capabilities = await db.protocolCapability.findMany({
    where: {
      tenantId: input.tenantId,
      status: "active",
      ...(input.type && { type: input.type }),
      ...(input.minReliability && { reliability: { gte: input.minReliability } }),
    },
    include: {
      _count: { select: { resources: true } },
    },
    orderBy: { reliability: "desc" },
  });

  return capabilities
    .map((cap) => {
      const coverage = JSON.parse(cap.coverage);
      return {
        id: cap.id,
        type: cap.type,
        providerType: cap.providerType,
        technicalSpec: JSON.parse(cap.technicalSpec),
        coverage,
        reliability: cap.reliability,
        resourceCount: cap._count.resources,
      };
    })
    .filter((cap) => {
      if (!input.country && !input.city) return true;
      const countries = (cap.coverage as Record<string, unknown>).countries as string[] | undefined;
      const cities = (cap.coverage as Record<string, unknown>).cities as string[] | undefined;
      if (input.country && countries && !countries.includes(input.country)) return false;
      if (input.city && cities && !cities.includes(input.city)) return false;
      return true;
    });
}

// ---------------------------------------------------------------------------
// Reserve a Resource (for switching)
// ---------------------------------------------------------------------------

export async function reserveResource(resourceId: string, sessionId: string): Promise<{
  reserved: boolean;
  reason?: string;
}> {
  const result = await db.protocolResource.updateMany({
    where: {
      id: resourceId,
      state: "AVAILABLE",
    },
    data: {
      state: "RESERVED",
      reservedAt: new Date(),
      reservedBy: sessionId,
    },
  });

  if (result.count === 0) {
    return { reserved: false, reason: "Resource not available or already reserved" };
  }

  logger.info("resource.reserved", { resourceId, sessionId });
  return { reserved: true };
}

// ---------------------------------------------------------------------------
// Release a Resource (ownership-safe)
// ---------------------------------------------------------------------------

/**
 * Release a resource. The release MUST be ownership-safe: only the session
 * that reserved (or is using) the resource can release it.
 *
 * This prevents session A from releasing a resource reserved by session B.
 */
export async function releaseResource(resourceId: string, sessionId: string): Promise<{
  released: boolean;
  reason?: string;
}> {
  // Only release if the resource is owned by this session
  const result = await db.protocolResource.updateMany({
    where: {
      id: resourceId,
      reservedBy: sessionId, // ownership guard
    },
    data: {
      state: "AVAILABLE",
      reservedAt: null,
      reservedBy: null,
    },
  });

  if (result.count === 0) {
    // Check if the resource exists at all
    const resource = await db.protocolResource.findUnique({
      where: { id: resourceId },
      select: { reservedBy: true, state: true },
    });

    if (!resource) {
      return { released: false, reason: "Resource not found" };
    }

    if (resource.reservedBy !== sessionId) {
      return { released: false, reason: `Ownership mismatch: resource is reserved by "${resource.reservedBy}", not "${sessionId}"` };
    }

    return { released: false, reason: `Resource is in state "${resource.state}", cannot release` };
  }

  logger.info("resource.released", { resourceId, sessionId });
  return { released: true };
}

// ---------------------------------------------------------------------------
// Mark Resource In Use (after activation)
// ---------------------------------------------------------------------------

export async function markResourceInUse(resourceId: string, sessionId: string): Promise<void> {
  await db.protocolResource.updateMany({
    where: { id: resourceId, reservedBy: sessionId },
    data: { state: "IN_USE" },
  });
}

// ---------------------------------------------------------------------------
// Discover Available Resources for a Capability
// ---------------------------------------------------------------------------

/**
 * Find AVAILABLE resources for a given capability. This is what the decision
 * engine calls to resolve a concrete allocatable resource from a capability.
 *
 * Intent → Capability → AVAILABLE Resources → pick best → reserve
 */
export async function discoverResources(capabilityId: string): Promise<Array<{
  id: string;
  state: string;
  identifiers: Record<string, unknown> | null;
  capacity: Record<string, unknown> | null;
  location: Record<string, unknown> | null;
}>> {
  const resources = await db.protocolResource.findMany({
    where: {
      capabilityId,
      state: "AVAILABLE",
    },
    orderBy: { createdAt: "asc" }, // oldest first (round-robin)
  });

  return resources.map((r) => ({
    id: r.id,
    state: r.state,
    identifiers: r.identifiers ? JSON.parse(r.identifiers) : null,
    capacity: r.capacity ? JSON.parse(r.capacity) : null,
    location: r.location ? JSON.parse(r.location) : null,
  }));
}

// ---------------------------------------------------------------------------
// Get Capability
// ---------------------------------------------------------------------------

export async function getCapability(capabilityId: string) {
  const cap = await db.protocolCapability.findUnique({
    where: { id: capabilityId },
    include: {
      resources: true,
    },
  });

  if (!cap) return null;

  return {
    id: cap.id,
    type: cap.type,
    providerType: cap.providerType,
    technicalSpec: JSON.parse(cap.technicalSpec),
    coverage: JSON.parse(cap.coverage),
    reliability: cap.reliability,
    status: cap.status,
    version: cap.version,
    resources: cap.resources.map((r) => ({
      id: r.id,
      state: r.state,
      identifiers: r.identifiers ? JSON.parse(r.identifiers) : null,
      capacity: r.capacity ? JSON.parse(r.capacity) : null,
    })),
  };
}
