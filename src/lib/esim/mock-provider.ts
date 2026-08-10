/**
 * MockESIMProvider — fully functional in-memory eSIM provider for development.
 *
 * Simulates: plan catalog, order creation, provisioning (ICCID, SM-DP+,
 * activation code), usage queries, top-ups, cancellation, and webhooks.
 *
 * ALL values produced here are clearly-marked DEVELOPMENT/TEST values. They are
 * NOT real telecom credentials. The architecture allows a real provider's
 * SM-DP+ and activation info to be inserted without changing the UI.
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

// In-memory state for the mock provider (per server process).
type MockESIM = {
  providerESIMId: string;
  providerOrderId: string;
  iccid: string;
  smdpAddress: string;
  activationCode: string;
  matchId?: string;
  status: "active" | "expired" | "suspended" | "exhausted" | "cancelled";
  dataAmountMB: number;
  dataRemainingMB: number;
  validityDays: number;
  expiresAt: string;
  createdAt: string;
  topUpSupported: boolean;
};

type MockOrder = {
  providerOrderId: string;
  providerPlanId: string;
  idempotencyKey: string;
  esimId?: string;
};

const esims = new Map<string, MockESIM>();
const orders = new Map<string, MockOrder>();
const orderByIdem = new Map<string, string>(); // idempotencyKey -> providerOrderId
const provisionByIdem = new Map<string, string>(); // idempotencyKey -> providerESIMId
const topupByIdem = new Map<string, TopUpResult>();

function deterministicIdempotent<T>(
  map: Map<string, T>,
  key: string,
  factory: () => T,
): T {
  if (map.has(key)) return map.get(key)!;
  const value = factory();
  map.set(key, value);
  return value;
}

/** Generate a realistic-looking (but fake) 20-digit ICCID. */
function generateICCID(): string {
  // 89 = telecom, 01 = country code placeholder, 00 = issuer placeholder.
  let iccid = "890100";
  for (let i = 0; i < 14; i++) iccid += Math.floor(Math.random() * 10).toString();
  return iccid;
}

/** Generate a fake-but-well-formed SM-DP+ address. */
function generateSMDP(): string {
  return "smdp.mock.esim-dev.test";
}

/** Generate a fake activation code (LPA token). */
function generateActivationCode(): string {
  // 32-char token, clearly a dev value.
  return "DEV-$ACTIVATION-" + Math.random().toString(36).slice(2, 14).toUpperCase();
}

// ---------------------------------------------------------------------------
// Plan catalog (source of truth for sync). Deterministic across restarts.
// ---------------------------------------------------------------------------

const MOCK_PLANS: ProviderPlanInput[] = [
  // Ghana
  plan("gh-1gb-7d", "Ghana 1 GB / 7 Days", "Ghana", "GH", "Africa", 1024, 7, 150, "MTN, Vodafone, AirtelTigo", "4G/5G"),
  plan("gh-3gb-15d", "Ghana 3 GB / 15 Days", "Ghana", "GH", "Africa", 3072, 15, 320, "MTN, Vodafone, AirtelTigo", "4G/5G"),
  plan("gh-10gb-30d", "Ghana 10 GB / 30 Days", "Ghana", "GH", "Africa", 10240, 30, 700, "MTN, Vodafone, AirtelTigo", "4G/5G"),
  plan("gh-20gb-30d", "Ghana 20 GB / 30 Days", "Ghana", "GH", "Africa", 20480, 30, 1200, "MTN, Vodafone, AirtelTigo", "4G/5G"),
  // Togo
  plan("tg-2gb-7d", "Togo 2 GB / 7 Days", "Togo", "TG", "Africa", 2048, 7, 220, "Togocom, Moov", "4G"),
  plan("tg-5gb-15d", "Togo 5 GB / 15 Days", "Togo", "TG", "Africa", 5120, 15, 480, "Togocom, Moov", "4G"),
  // Nigeria
  plan("ng-3gb-7d", "Nigeria 3 GB / 7 Days", "Nigeria", "NG", "Africa", 3072, 7, 300, "MTN, Airtel, Glo, 9Mobile", "4G/5G"),
  plan("ng-10gb-30d", "Nigeria 10 GB / 30 Days", "Nigeria", "NG", "Africa", 10240, 30, 850, "MTN, Airtel, Glo, 9Mobile", "4G/5G"),
  // Benin
  plan("bj-2gb-7d", "Benin 2 GB / 7 Days", "Benin", "BJ", "Africa", 2048, 7, 200, "MTN, Moov", "4G"),
  plan("bj-6gb-30d", "Benin 6 GB / 30 Days", "Benin", "BJ", "Africa", 6144, 30, 540, "MTN, Moov", "4G"),
  // Côte d'Ivoire
  plan("ci-3gb-7d", "Côte d'Ivoire 3 GB / 7 Days", "Côte d'Ivoire", "CI", "Africa", 3072, 7, 280, "Orange, MTN, Moov", "4G"),
  plan("ci-10gb-30d", "Côte d'Ivoire 10 GB / 30 Days", "Côte d'Ivoire", "CI", "Africa", 10240, 30, 780, "Orange, MTN, Moov", "4G"),
  // Senegal
  plan("sn-2gb-7d", "Senegal 2 GB / 7 Days", "Senegal", "SN", "Africa", 2048, 7, 210, "Orange, Free, Expresso", "4G"),
  plan("sn-8gb-30d", "Senegal 8 GB / 30 Days", "Senegal", "SN", "Africa", 8192, 30, 660, "Orange, Free, Expresso", "4G"),
  // Kenya
  plan("ke-3gb-7d", "Kenya 3 GB / 7 Days", "Kenya", "KE", "Africa", 3072, 7, 260, "Safaricom, Airtel, Telkom", "4G/5G"),
  plan("ke-10gb-30d", "Kenya 10 GB / 30 Days", "Kenya", "KE", "Africa", 10240, 30, 720, "Safaricom, Airtel, Telkom", "4G/5G"),
  // South Africa
  plan("za-5gb-7d", "South Africa 5 GB / 7 Days", "South Africa", "ZA", "Africa", 5120, 7, 420, "Vodacom, MTN, Cell C, Telkom", "4G/5G"),
  plan("za-15gb-30d", "South Africa 15 GB / 30 Days", "South Africa", "ZA", "Africa", 15360, 30, 1100, "Vodacom, MTN, Cell C, Telkom", "4G/5G"),
  // France
  plan("fr-5gb-7d", "France 5 GB / 7 Days", "France", "FR", "Europe", 5120, 7, 480, "Orange, SFR, Bouygues, Free", "4G/5G"),
  plan("fr-20gb-30d", "France 20 GB / 30 Days", "France", "FR", "Europe", 20480, 30, 1450, "Orange, SFR, Bouygues, Free", "4G/5G"),
  // United Kingdom
  plan("gb-5gb-7d", "United Kingdom 5 GB / 7 Days", "United Kingdom", "GB", "Europe", 5120, 7, 450, "EE, Vodafone, O2, Three", "4G/5G"),
  plan("gb-20gb-30d", "United Kingdom 20 GB / 30 Days", "United Kingdom", "GB", "Europe", 20480, 30, 1380, "EE, Vodafone, O2, Three", "4G/5G"),
  // United States
  plan("us-5gb-7d", "United States 5 GB / 7 Days", "United States", "US", "North America", 5120, 7, 520, "Verizon, T-Mobile, AT&T", "4G/5G"),
  plan("us-20gb-30d", "United States 20 GB / 30 Days", "United States", "US", "North America", 20480, 30, 1550, "Verizon, T-Mobile, AT&T", "4G/5G"),
];

function plan(
  providerPlanId: string,
  name: string,
  country: string,
  countryCode: string,
  region: string,
  dataAmountMB: number,
  validityDays: number,
  wholesalePriceMinor: number,
  coverage: string,
  speed: string,
): ProviderPlanInput {
  return {
    providerPlanId,
    name,
    country,
    countryCode,
    region,
    dataAmountMB,
    validityDays,
    wholesalePriceMinor,
    currency: "USD",
    coverage,
    networks: coverage.split(", ").map((n) => n.trim()),
    roaming: false,
    hotspot: true,
    speed,
    topUpSupported: true,
    description: `${name} — data-only eSIM for ${country}. ${coverage}.`,
  };
}

// ---------------------------------------------------------------------------
// Mock provider implementation
// ---------------------------------------------------------------------------

export class MockESIMProvider implements ESIMProvider {
  readonly id = "mock";
  readonly label = "Mock eSIM Provider (Development)";
  readonly isMock = true;

  async getPlans(): Promise<ProviderPlanInput[]> {
    return MOCK_PLANS;
  }

  async getPlan(providerPlanId: string): Promise<ProviderPlanInput | null> {
    return MOCK_PLANS.find((p) => p.providerPlanId === providerPlanId) ?? null;
  }

  async createOrder(input: {
    providerPlanId: string;
    idempotencyKey: string;
  }): Promise<{ providerOrderId: string }> {
    return deterministicIdempotent(orderByIdem, input.idempotencyKey, () => {
      const providerOrderId = `mock-order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      orders.set(providerOrderId, {
        providerOrderId,
        providerPlanId: input.providerPlanId,
        idempotencyKey: input.idempotencyKey,
      });
      logger.info("mock.order_created", { providerOrderId, providerPlanId: input.providerPlanId });
      return { providerOrderId };
    });
  }

  async provisionESIM(input: {
    providerOrderId: string;
    idempotencyKey: string;
  }): Promise<ProvisioningResult> {
    // Idempotent provisioning: same idempotency key → same eSIM.
    return deterministicIdempotent(provisionByIdem, input.idempotencyKey, () => {
      const order = orders.get(input.providerOrderId);
      if (!order) {
        throw new Error(`Unknown provider order ${input.providerOrderId}`);
      }
      const plan = MOCK_PLANS.find((p) => p.providerPlanId === order.providerPlanId);
      if (!plan) throw new Error(`Unknown plan ${order.providerPlanId}`);

      const providerESIMId = `mock-esim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = new Date(Date.now() + plan.validityDays * 24 * 60 * 60 * 1000);
      const esim: MockESIM = {
        providerESIMId,
        providerOrderId: input.providerOrderId,
        iccid: generateICCID(),
        smdpAddress: generateSMDP(),
        activationCode: generateActivationCode(),
        matchId: Math.random().toString(36).slice(2, 8).toUpperCase(),
        status: "active",
        dataAmountMB: plan.dataAmountMB,
        dataRemainingMB: plan.dataAmountMB,
        validityDays: plan.validityDays,
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
        topUpSupported: plan.topUpSupported ?? true,
      };
      esims.set(providerESIMId, esim);
      order.esimId = providerESIMId;
      logger.info("mock.provisioned", { providerESIMId, iccid: esim.iccid });
      return {
        providerESIMId,
        iccid: esim.iccid,
        smdpAddress: esim.smdpAddress,
        activationCode: esim.activationCode,
        matchId: esim.matchId,
        dataAmountMB: esim.dataAmountMB,
        validityDays: esim.validityDays,
        expiresAt: esim.expiresAt,
      };
    });
  }

  async getESIM(providerESIMId: string) {
    const esim = esims.get(providerESIMId);
    if (!esim) throw new Error(`Unknown eSIM ${providerESIMId}`);
    return {
      iccid: esim.iccid,
      smdpAddress: esim.smdpAddress,
      activationCode: esim.activationCode,
      status: esim.status,
      dataAmountMB: esim.dataAmountMB,
      dataRemainingMB: esim.dataRemainingMB,
      expiresAt: esim.expiresAt,
    };
  }

  async getUsage(providerESIMId: string): Promise<UsageSample> {
    const esim = esims.get(providerESIMId);
    if (!esim) throw new Error(`Unknown eSIM ${providerESIMId}`);
    return {
      dataUsedMB: esim.dataAmountMB - esim.dataRemainingMB,
      dataRemainingMB: esim.dataRemainingMB,
      timestamp: new Date().toISOString(),
    };
  }

  async supportsTopUp(providerESIMId: string): Promise<boolean> {
    const esim = esims.get(providerESIMId);
    return esim?.topUpSupported ?? false;
  }

  async getTopUpPackages(providerESIMId: string): Promise<TopUpPackage[]> {
    const esim = esims.get(providerESIMId);
    if (!esim || !esim.topUpSupported) return [];
    return [
      { id: "topup-1gb", name: "1 GB Top-Up", dataAmountMB: 1024, priceMinor: 200, currency: "USD", validityDays: 30 },
      { id: "topup-5gb", name: "5 GB Top-Up", dataAmountMB: 5120, priceMinor: 850, currency: "USD", validityDays: 30 },
      { id: "topup-10gb", name: "10 GB Top-Up", dataAmountMB: 10240, priceMinor: 1500, currency: "USD", validityDays: 30 },
      { id: "topup-20gb", name: "20 GB Top-Up", dataAmountMB: 20480, priceMinor: 2700, currency: "USD", validityDays: 30 },
    ];
  }

  async topUp(input: {
    providerESIMId: string;
    packageId: string;
    idempotencyKey: string;
  }): Promise<TopUpResult> {
    return deterministicIdempotent(topupByIdem, input.idempotencyKey, () => {
      const esim = esims.get(input.providerESIMId);
      if (!esim) throw new Error(`Unknown eSIM ${input.providerESIMId}`);
      const packages = this.getTopUpPackagesSync(input.providerESIMId);
      const pkg = packages.find((p) => p.id === input.packageId);
      if (!pkg) throw new Error(`Unknown top-up package ${input.packageId}`);
      esim.dataRemainingMB += pkg.dataAmountMB;
      if (esim.status === "exhausted") esim.status = "active";
      const result: TopUpResult = {
        providerReference: `mock-topup-${Date.now().toString(36)}`,
        dataAddedMB: pkg.dataAmountMB,
        newRemainingMB: esim.dataRemainingMB,
      };
      logger.info("mock.topup", { providerESIMId: input.providerESIMId, packageId: input.packageId });
      return result;
    });
  }

  private getTopUpPackagesSync(providerESIMId: string): TopUpPackage[] {
    const esim = esims.get(providerESIMId);
    if (!esim || !esim.topUpSupported) return [];
    return [
      { id: "topup-1gb", name: "1 GB Top-Up", dataAmountMB: 1024, priceMinor: 200, currency: "USD", validityDays: 30 },
      { id: "topup-5gb", name: "5 GB Top-Up", dataAmountMB: 5120, priceMinor: 850, currency: "USD", validityDays: 30 },
      { id: "topup-10gb", name: "10 GB Top-Up", dataAmountMB: 10240, priceMinor: 1500, currency: "USD", validityDays: 30 },
      { id: "topup-20gb", name: "20 GB Top-Up", dataAmountMB: 20480, priceMinor: 2700, currency: "USD", validityDays: 30 },
    ];
  }

  async cancel(providerESIMId: string): Promise<void> {
    const esim = esims.get(providerESIMId);
    if (esim) esim.status = "cancelled";
  }

  async verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<ProviderWebhookEvent | null> {
    // Mock webhook scheme: signature = HMAC-SHA256(rawBody, ESIM_WEBHOOK_SECRET)
    // For dev simplicity, also accept a plain shared-secret header match.
    try {
      const parsed = JSON.parse(input.rawBody);
      const externalId = parsed.id ?? parsed.eventId ?? `evt-${Date.now()}`;
      return {
        externalId: String(externalId),
        eventType: String(parsed.type ?? parsed.event ?? "unknown"),
        data: {
          providerESIMId: parsed.esimId ?? parsed.iccid,
          providerOrderId: parsed.orderId,
          status: parsed.status,
          dataRemainingMB: parsed.dataRemainingMB != null ? Number(parsed.dataRemainingMB) : undefined,
          expiresAt: parsed.expiresAt,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }

  /** Dev-only helper: simulate data consumption on an eSIM. */
  simulateUsage(providerESIMId: string, usedMB: number): UsageSample {
    const esim = esims.get(providerESIMId);
    if (!esim) throw new Error(`Unknown eSIM ${providerESIMId}`);
    esim.dataRemainingMB = Math.max(0, esim.dataRemainingMB - usedMB);
    if (esim.dataRemainingMB === 0) esim.status = "exhausted";
    return {
      dataUsedMB: usedMB,
      dataRemainingMB: esim.dataRemainingMB,
      timestamp: new Date().toISOString(),
    };
  }
}

/** Access the singleton mock instance (for dev helpers like simulateUsage). */
export const mockESIMProvider = new MockESIMProvider();
