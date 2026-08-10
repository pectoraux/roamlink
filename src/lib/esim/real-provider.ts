/**
 * RealESIMProvider — adapter boundary for a production eSIM provider.
 *
 * This is a STRUCTURAL BOUNDARY, not a functional integration. We do NOT
 * fabricate a real provider API. When a real provider's documentation and
 * credentials are supplied, implement the methods below against that provider's
 * actual HTTP API, normalizing their native payloads into our CanonicalPlan /
 * ProvisioningResult types.
 *
 * Typical real provider flow (e.g. Airalo, Soracom, eSIMX):
 *   1. getPlans()        -> GET /plans, map to ProviderPlanInput[]
 *   2. createOrder()     -> POST /orders (with Idempotency-Key header)
 *   3. provisionESIM()   -> POST /orders/{id}/esim or GET /orders/{id}
 *   4. getESIM()         -> GET /esims/{id}
 *   5. getUsage()        -> GET /esims/{id}/usage
 *   6. getTopUpPackages()-> GET /esims/{id}/topups
 *   7. topUp()           -> POST /esims/{id}/topups
 *   8. cancel()          -> POST /esims/{id}/cancel
 *   9. verifyWebhook()   -> verify HMAC-SHA256 signature with provider secret
 *
 * Credentials come from ESIM_API_URL / ESIM_API_KEY / ESIM_API_SECRET — these
 * are SERVER-ONLY env vars and must never be exposed to the browser.
 */

import type {
  ESIMProvider,
  ProviderPlanInput,
  ProviderWebhookEvent,
} from "./provider";
import type {
  ProvisioningResult,
  TopUpPackage,
  TopUpResult,
  UsageSample,
} from "@/types";
import { logger } from "@/lib/logger";
import { safeEqual } from "@/lib/security";
import { createHmac } from "crypto";

export class RealESIMProvider implements ESIMProvider {
  readonly id = process.env.ESIM_PROVIDER || "real";
  readonly label = "Real eSIM Provider";
  readonly isMock = false;

  private get apiUrl() {
    return process.env.ESIM_API_URL;
  }
  private get apiKey() {
    return process.env.ESIM_API_KEY;
  }

  private assertConfigured(operation: string) {
    if (!this.apiUrl || !this.apiKey) {
      logger.error("real.provider.not_configured", { operation, apiUrl: !!this.apiUrl });
      throw new Error(
        `RealESIMProvider is not configured. Set ESIM_API_URL and ESIM_API_KEY to use ESIM_PROVIDER=${this.id}.`,
      );
    }
  }

  async getPlans(): Promise<ProviderPlanInput[]> {
    this.assertConfigured("getPlans");
    // TODO: GET {apiUrl}/plans, normalize provider-native plan objects into
    // ProviderPlanInput[]. Map wholesale cost, coverage, networks, etc.
    throw new Error("RealESIMProvider.getPlans() not implemented — implement against your provider's API.");
  }

  async getPlan(providerPlanId: string): Promise<ProviderPlanInput | null> {
    this.assertConfigured("getPlan");
    void providerPlanId;
    throw new Error("RealESIMProvider.getPlan() not implemented.");
  }

  async createOrder(input: { providerPlanId: string; idempotencyKey: string }): Promise<{ providerOrderId: string }> {
    this.assertConfigured("createOrder");
    // TODO: POST {apiUrl}/orders with Idempotency-Key header.
    void input;
    throw new Error("RealESIMProvider.createOrder() not implemented.");
  }

  async provisionESIM(input: { providerOrderId: string; idempotencyKey: string }): Promise<ProvisioningResult> {
    this.assertConfigured("provisionESIM");
    void input;
    throw new Error("RealESIMProvider.provisionESIM() not implemented.");
  }

  async getESIM(providerESIMId: string) {
    this.assertConfigured("getESIM");
    void providerESIMId;
    throw new Error("RealESIMProvider.getESIM() not implemented.");
  }

  async getUsage(providerESIMId: string): Promise<UsageSample> {
    this.assertConfigured("getUsage");
    void providerESIMId;
    throw new Error("RealESIMProvider.getUsage() not implemented.");
  }

  async supportsTopUp(providerESIMId: string): Promise<boolean> {
    this.assertConfigured("supportsTopUp");
    void providerESIMId;
    throw new Error("RealESIMProvider.supportsTopUp() not implemented.");
  }

  async getTopUpPackages(providerESIMId: string): Promise<TopUpPackage[]> {
    this.assertConfigured("getTopUpPackages");
    void providerESIMId;
    throw new Error("RealESIMProvider.getTopUpPackages() not implemented.");
  }

  async topUp(input: { providerESIMId: string; packageId: string; idempotencyKey: string }): Promise<TopUpResult> {
    this.assertConfigured("topUp");
    void input;
    throw new Error("RealESIMProvider.topUp() not implemented.");
  }

  async cancel(providerESIMId: string): Promise<void> {
    this.assertConfigured("cancel");
    void providerESIMId;
    throw new Error("RealESIMProvider.cancel() not implemented.");
  }

  async verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<ProviderWebhookEvent | null> {
    // Typical scheme: provider sends header like X-Signature: hex HMAC.
    const secret = process.env.ESIM_WEBHOOK_SECRET;
    if (!secret) return null;
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
    if (!input.signature || !safeEqual(input.signature, expected)) return null;
    try {
      const parsed = JSON.parse(input.rawBody);
      return {
        externalId: String(parsed.id ?? parsed.event_id ?? `evt-${Date.now()}`),
        eventType: String(parsed.type ?? parsed.event ?? "unknown"),
        data: {
          providerESIMId: parsed.esim_id ?? parsed.iccid,
          providerOrderId: parsed.order_id,
          status: parsed.status,
          dataRemainingMB: parsed.data_remaining_mb != null ? Number(parsed.data_remaining_mb) : undefined,
          expiresAt: parsed.expires_at,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }
}
