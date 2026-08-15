/**
 * Phase 2C.5 — eSIM Supplier Provider Client (Real)
 *
 * Implements the EsimProviderClient interface against a real eSIM supplier
 * REST API. Mirrors RouterOSProviderClient exactly:
 *
 *   - GET-first idempotency: GET by reference → if exists, return it
 *   - CONFLICT reconciliation: POST → 409 → GET → return existing
 *   - TIMEOUT reconciliation: POST → timeout → GET → return existing or retry
 *   - Fail-closed on lookup uncertainty (never POST with unknown state)
 *
 * Resource identity:
 *   RoamLink providerResourceId = eSIM ICCID (supplier-assigned, immutable)
 *   reference = deterministic convergence key (derived from binding ID)
 */

import type { EsimProviderClient, EsimResource, EsimResourceConfig } from "./client";
import { EsimProviderError } from "./client";
import type { EsimTransport } from "./transport";
import { logger } from "@/lib/logger";

export class EsimSupplierClient implements EsimProviderClient {
  constructor(
    private readonly transport: EsimTransport,
    public readonly instanceLabel?: string,
  ) {}

  async createProfile(config: EsimResourceConfig): Promise<EsimResource> {
    // Step 1: GET by reference (idempotency check). FAIL CLOSED on uncertainty.
    let existing: EsimResource | null;
    try {
      existing = await this.getProfileByReference(config.reference);
    } catch (err) {
      if (err instanceof EsimProviderError) {
        logger.error("esim.create_lookup_failed_closed", {
          reference: config.reference, instance: this.instanceLabel,
          errorType: err.errorType, error: err.message,
          message: "CRITICAL: Idempotency lookup failed — refusing to create with unknown external state.",
        });
        throw err;
      }
      throw err;
    }
    if (existing) {
      logger.info("esim.create_idempotent", { reference: config.reference, instance: this.instanceLabel });
      return existing;
    }

    // Step 2: POST (create)
    const body: Record<string, unknown> = {
      reference: config.reference,
    };
    if (config.dataLimitBytes && config.dataLimitBytes > 0) {
      body.dataLimitBytes = config.dataLimitBytes;
    }
    if (config.allowedCountries && config.allowedCountries.length > 0) {
      body.allowedCountries = config.allowedCountries;
    }
    if (config.validityDays && config.validityDays > 0) {
      body.validityDays = config.validityDays;
    }

    try {
      const created = await this.transport.request<Record<string, unknown>>({
        method: "POST",
        path: "/profiles",
        body,
      });
      logger.info("esim.created", { reference: config.reference, instance: this.instanceLabel });
      return this.parseResource(created ?? {});
    } catch (err) {
      // CONFLICT reconciliation (same as RouterOS)
      if (err instanceof EsimProviderError && err.errorType === "CONFLICT") {
        logger.warn("esim.create_conflict_reconciling", {
          reference: config.reference, instance: this.instanceLabel,
          message: "POST conflicted — reconciling via GET to converge on the existing profile.",
        });
        const reconciled = await this.getProfileByReference(config.reference);
        if (reconciled) {
          logger.info("esim.create_conflict_reconciled", {
            reference: config.reference, iccid: reconciled.id, instance: this.instanceLabel,
          });
          return reconciled;
        }
        logger.error("esim.create_conflict_inconsistent", {
          reference: config.reference, instance: this.instanceLabel,
          message: "CRITICAL: POST conflicted but GET cannot find the profile — supplier state is inconsistent.",
        });
        throw new EsimProviderError("PERMANENT", `Supplier inconsistency: POST conflicted but GET cannot find profile "${config.reference}"`);
      }

      // TIMEOUT/RETRYABLE reconciliation (same as RouterOS)
      if (err instanceof EsimProviderError && (err.errorType === "TIMEOUT" || err.errorType === "RETRYABLE")) {
        logger.warn("esim.create_uncertain", {
          reference: config.reference, instance: this.instanceLabel,
          message: "Create had uncertain outcome — reconciling via GET before retry.",
        });
        const reconciled = await this.getProfileByReference(config.reference);
        if (reconciled) {
          logger.info("esim.create_reconciled", { reference: config.reference, instance: this.instanceLabel });
          return reconciled;
        }
        logger.info("esim.create_retry_after_reconcile", { reference: config.reference, instance: this.instanceLabel });
        const created = await this.transport.request<Record<string, unknown>>({
          method: "POST", path: "/profiles", body,
        });
        return this.parseResource(created ?? {});
      }
      throw err;
    }
  }

  async getProfile(iccid: string): Promise<EsimResource | null> {
    const data = await this.transport.request<Record<string, unknown>>({
      method: "GET",
      path: `/profiles/${encodeURIComponent(iccid)}`,
    });
    if (data === null) return null;
    return this.parseResource(data);
  }

  private async getProfileByReference(reference: string): Promise<EsimResource | null> {
    const results = await this.transport.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: `/profiles?reference=${encodeURIComponent(reference)}`,
    });
    if (!results || results.length === 0) return null;
    return this.parseResource(results[0]);
  }

  async suspendProfile(iccid: string): Promise<void> {
    await this.transport.request({
      method: "PATCH",
      path: `/profiles/${encodeURIComponent(iccid)}`,
      body: { status: "suspended" },
    });
  }

  async resumeProfile(iccid: string): Promise<void> {
    await this.transport.request({
      method: "PATCH",
      path: `/profiles/${encodeURIComponent(iccid)}`,
      body: { status: "active" },
    });
  }

  async releaseProfile(iccid: string): Promise<void> {
    await this.transport.request({
      method: "DELETE",
      path: `/profiles/${encodeURIComponent(iccid)}`,
    });
  }

  async getProfileUsage(iccid: string): Promise<{
    dataUsedBytes: number;
    dataLimitBytes: number;
    remainingBytes: number;
    isActive: boolean;
  } | null> {
    const usage = await this.transport.request<{
      dataUsedBytes: number;
      dataLimitBytes: number;
      remainingBytes: number;
      isActive: boolean;
    }>({
      method: "GET",
      path: `/profiles/${encodeURIComponent(iccid)}/usage`,
    });
    return usage;
  }

  private parseResource(data: Record<string, unknown>): EsimResource {
    return {
      id: (data.iccid as string) ?? "",
      reference: (data.reference as string) ?? "",
      resourceType: "esim_profile",
      isActive: data.status !== "suspended",
      dataLimitBytes: data.dataLimitBytes as number | undefined,
      dataUsedBytes: data.dataUsedBytes as number | undefined,
      allowedCountries: data.allowedCountries as string[] | undefined,
      validityDays: data.validityDays as number | undefined,
      createdAt: new Date((data.createdAt as string) ?? Date.now()),
    };
  }
}
