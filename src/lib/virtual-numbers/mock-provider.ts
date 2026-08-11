/**
 * MockVirtualNumberProvider — simulated telecom provider for development.
 *
 * Generates fake but realistic phone numbers across supported countries.
 * Simulates: number search, purchase, release, SMS (inbound/outbound),
 * voice calls, and webhooks.
 *
 * ALL values are clearly-marked development/test values. NOT real telecom.
 */

import type {
  VirtualNumberProvider,
  ProviderNumber,
  ProviderMessage,
  ProviderCall,
  VNWebhookEvent,
  SearchNumbersParams,
  SendSMSParams,
  MakeCallParams,
  NumberType,
} from "./provider";
import { logger } from "@/lib/logger";
import { safeEqual } from "@/lib/security";
import { createHmac } from "crypto";

// In-memory number inventory (per process).
const inventory = new Map<string, ProviderNumber>();
const purchased = new Map<string, ProviderNumber>(); // providerNumberId -> number
const messages = new Map<string, ProviderMessage[]>(); // providerNumberId -> messages
const purchaseByIdem = new Map<string, ProviderNumber>();

// Country catalog with calling codes + sample area codes.
const COUNTRY_CATALOG: { code: string; name: string; callingCode: string; regions: { name: string; areaCode: string }[]; sms: boolean; voice: boolean; mms: boolean }[] = [
  { code: "GH", name: "Ghana", callingCode: "233", regions: [{ name: "Accra", areaCode: "30" }, { name: "Kumasi", areaCode: "32" }], sms: true, voice: true, mms: false },
  { code: "NG", name: "Nigeria", callingCode: "234", regions: [{ name: "Lagos", areaCode: "1" }, { name: "Abuja", areaCode: "9" }], sms: true, voice: true, mms: false },
  { code: "TG", name: "Togo", callingCode: "228", regions: [{ name: "Lomé", areaCode: "90" }], sms: true, voice: false, mms: false },
  { code: "US", name: "United States", callingCode: "1", regions: [{ name: "New York", areaCode: "212" }, { name: "California", areaCode: "415" }, { name: "Texas", areaCode: "512" }], sms: true, voice: true, mms: true },
  { code: "GB", name: "United Kingdom", callingCode: "44", regions: [{ name: "London", areaCode: "20" }, { name: "Manchester", areaCode: "161" }], sms: true, voice: true, mms: true },
  { code: "FR", name: "France", callingCode: "33", regions: [{ name: "Paris", areaCode: "1" }, { name: "Marseille", areaCode: "4" }], sms: true, voice: true, mms: false },
  { code: "KE", name: "Kenya", callingCode: "254", regions: [{ name: "Nairobi", areaCode: "20" }], sms: true, voice: true, mms: false },
  { code: "ZA", name: "South Africa", callingCode: "27", regions: [{ name: "Johannesburg", areaCode: "11" }, { name: "Cape Town", areaCode: "21" }], sms: true, voice: true, mms: false },
];

function generateNumber(countryCode: string, areaCode: string): string {
  const country = COUNTRY_CATALOG.find((c) => c.code === countryCode);
  if (!country) return "+10000000000";
  const suffix = Math.floor(1000000 + Math.random() * 8999999).toString();
  return `+${country.callingCode}${areaCode}${suffix}`;
}

function generatePrice(countryCode: string): { cost: number; price: number } {
  // Mock wholesale costs (monthly, in minor units)
  const costs: Record<string, number> = { GH: 150, NG: 200, TG: 120, US: 350, GB: 400, FR: 300, KE: 180, ZA: 200 };
  const cost = costs[countryCode] ?? 250;
  // Markup ~60-70%
  const price = Math.round(cost * 1.65);
  return { cost, price };
}

/** Initialize the inventory on first access. */
function ensureInventory() {
  if (inventory.size > 0) return;
  for (const country of COUNTRY_CATALOG) {
    for (const region of country.regions) {
      // Generate 3 numbers per region
      for (let i = 0; i < 3; i++) {
        const e164 = generateNumber(country.code, region.areaCode);
        const id = `mock-vn-${country.code}-${region.areaCode}-${i}`;
        const { cost, price } = generatePrice(country.code);
        inventory.set(id, {
          providerNumberId: id,
          e164,
          country: country.name,
          countryCode: country.code,
          region: region.name,
          numberType: "local" as NumberType,
          smsEnabled: country.sms,
          mmsEnabled: country.mms,
          voiceEnabled: country.voice,
          monthlyCostMinor: cost,
          currency: "USD",
        });
        // Store price separately (not on ProviderNumber type, but needed for purchase)
        (inventory.get(id) as any).sellingPriceMinor = price;
      }
    }
  }
  logger.info("mock.vn_inventory_initialized", { count: inventory.size });
}

export class MockVirtualNumberProvider implements VirtualNumberProvider {
  readonly id = "mock";
  readonly label = "Mock Virtual Number Provider (Development)";
  readonly isMock = true;

  async searchNumbers(params: SearchNumbersParams): Promise<ProviderNumber[]> {
    ensureInventory();
    let results = Array.from(inventory.values()).filter((n) => !purchased.has(n.providerNumberId));

    if (params.countryCode) results = results.filter((n) => n.countryCode === params.countryCode);
    if (params.region) results = results.filter((n) => n.region === params.region);
    if (params.smsRequired) results = results.filter((n) => n.smsEnabled);
    if (params.voiceRequired) results = results.filter((n) => n.voiceEnabled);
    if (params.mmsRequired) results = results.filter((n) => n.mmsEnabled);
    if (params.numberType) results = results.filter((n) => n.numberType === params.numberType);

    const limit = params.limit ?? 20;
    return results.slice(0, limit);
  }

  async getNumber(providerNumberId: string): Promise<ProviderNumber | null> {
    ensureInventory();
    return inventory.get(providerNumberId) ?? purchased.get(providerNumberId) ?? null;
  }

  async purchaseNumber(input: { providerNumberId: string; idempotencyKey: string }): Promise<ProviderNumber> {
    ensureInventory();
    // Idempotent
    const existing = purchaseByIdem.get(input.idempotencyKey);
    if (existing) return existing;

    const number = inventory.get(input.providerNumberId);
    if (!number) throw new Error(`Number not found: ${input.providerNumberId}`);
    if (purchased.has(input.providerNumberId)) throw new Error(`Number already purchased: ${input.providerNumberId}`);

    purchased.set(input.providerNumberId, number);
    inventory.delete(input.providerNumberId);
    purchaseByIdem.set(input.idempotencyKey, number);
    messages.set(input.providerNumberId, []);
    logger.info("mock.vn_purchased", { providerNumberId: input.providerNumberId, e164: number.e164 });
    return number;
  }

  async releaseNumber(providerNumberId: string): Promise<void> {
    purchased.delete(providerNumberId);
    messages.delete(providerNumberId);
    logger.info("mock.vn_released", { providerNumberId });
  }

  async configureNumber(input: { providerNumberId: string; smsWebhookUrl?: string; voiceWebhookUrl?: string }): Promise<void> {
    logger.info("mock.vn_configured", { providerNumberId: input.providerNumberId });
  }

  async sendSMS(params: SendSMSParams): Promise<ProviderMessage> {
    const msg: ProviderMessage = {
      providerMessageId: `mock-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      direction: "outbound",
      from: purchased.get(params.providerNumberId)?.e164 ?? "unknown",
      to: params.to,
      body: params.body,
      status: "sent",
      segments: Math.max(1, Math.ceil(params.body.length / 160)),
      timestamp: new Date().toISOString(),
    };
    const list = messages.get(params.providerNumberId) ?? [];
    list.push(msg);
    messages.set(params.providerNumberId, list);
    logger.info("mock.sms_sent", { providerNumberId: params.providerNumberId, to: params.to });
    return msg;
  }

  async getMessages(input: { providerNumberId: string; limit?: number }): Promise<ProviderMessage[]> {
    const list = messages.get(input.providerNumberId) ?? [];
    return list.slice(-(input.limit ?? 50));
  }

  async makeCall(params: MakeCallParams): Promise<ProviderCall> {
    const call: ProviderCall = {
      providerCallId: `mock-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      direction: "outbound",
      from: purchased.get(params.providerNumberId)?.e164 ?? "unknown",
      to: params.to,
      status: "completed",
      durationSeconds: Math.floor(10 + Math.random() * 300),
      timestamp: new Date().toISOString(),
    };
    logger.info("mock.call_made", { providerNumberId: params.providerNumberId, to: params.to });
    return call;
  }

  async verifyWebhook(input: { signature: string | null; rawBody: string }): Promise<VNWebhookEvent | null> {
    const secret = process.env.VN_WEBHOOK_SECRET;
    if (!secret || !input.signature) return null;
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
    if (!safeEqual(input.signature, expected)) return null;
    try {
      const parsed = JSON.parse(input.rawBody);
      return {
        externalId: String(parsed.id ?? `evt-${Date.now()}`),
        eventType: String(parsed.type ?? "unknown"),
        data: {
          providerNumberId: parsed.providerNumberId ?? parsed.data?.providerNumberId,
          e164: parsed.e164 ?? parsed.data?.e164,
          message: parsed.message ?? parsed.data?.message,
          call: parsed.call ?? parsed.data?.call,
        },
        raw: parsed,
      };
    } catch {
      return null;
    }
  }

  /** Dev-only: simulate an inbound SMS to a number. */
  simulateInboundSMS(providerNumberId: string, from: string, body: string): ProviderMessage {
    const msg: ProviderMessage = {
      providerMessageId: `mock-msg-in-${Date.now()}`,
      direction: "inbound",
      from,
      to: purchased.get(providerNumberId)?.e164 ?? "unknown",
      body,
      status: "received",
      segments: Math.max(1, Math.ceil(body.length / 160)),
      timestamp: new Date().toISOString(),
    };
    const list = messages.get(providerNumberId) ?? [];
    list.push(msg);
    messages.set(providerNumberId, list);
    return msg;
  }
}

export const mockVNProvider = new MockVirtualNumberProvider();
