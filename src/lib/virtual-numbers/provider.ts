/**
 * VirtualNumberProvider — the abstraction boundary for telecom number providers.
 *
 * The application NEVER talks to a specific telecom provider (Telnyx, Twilio,
 * Vonage) directly. It talks to this interface. Concrete implementations
 * (MockVirtualNumberProvider, RealVirtualNumberProvider adapter) live in
 * separate files and are selected by VN_PROVIDER env var.
 *
 * Provider-native data shapes are normalized into canonical types.
 */

import type { Currency } from "@/lib/money";

export type NumberType = "local" | "toll_free" | "mobile" | "national";

export type ProviderNumber = {
  providerNumberId: string;
  e164: string;
  country: string;
  countryCode: string;
  region?: string;
  city?: string;
  numberType: NumberType;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  voiceEnabled: boolean;
  monthlyCostMinor: number;
  currency: Currency;
};

export type SearchNumbersParams = {
  countryCode?: string;
  region?: string;
  smsRequired?: boolean;
  voiceRequired?: boolean;
  mmsRequired?: boolean;
  numberType?: NumberType;
  limit?: number;
};

export type SendSMSParams = {
  providerNumberId: string;
  to: string;
  body: string;
};

export type ProviderMessage = {
  providerMessageId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  status: "received" | "sent" | "delivered" | "failed";
  segments: number;
  timestamp: string;
};

export type MakeCallParams = {
  providerNumberId: string;
  to: string;
};

export type ProviderCall = {
  providerCallId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: "ringing" | "in_progress" | "completed" | "failed" | "no_answer" | "busy";
  durationSeconds: number;
  timestamp: string;
};

export type VNWebhookEvent = {
  externalId: string;
  eventType: string;
  data: {
    providerNumberId?: string;
    e164?: string;
    message?: Partial<ProviderMessage>;
    call?: Partial<ProviderCall>;
  };
  raw: unknown;
};

export interface VirtualNumberProvider {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;

  /** Search available numbers. */
  searchNumbers(params: SearchNumbersParams): Promise<ProviderNumber[]>;

  /** Get a single number by provider id. */
  getNumber(providerNumberId: string): Promise<ProviderNumber | null>;

  /** Purchase/reserve a number. Idempotent via idempotencyKey. */
  purchaseNumber(input: { providerNumberId: string; idempotencyKey: string }): Promise<ProviderNumber>;

  /** Release a number back to the provider. */
  releaseNumber(providerNumberId: string): Promise<void>;

  /** Configure number capabilities (SMS webhook URL, voice app, etc.). */
  configureNumber(input: { providerNumberId: string; smsWebhookUrl?: string; voiceWebhookUrl?: string }): Promise<void>;

  /** Send an SMS. */
  sendSMS(params: SendSMSParams): Promise<ProviderMessage>;

  /** Get messages for a number. */
  getMessages(input: { providerNumberId: string; limit?: number }): Promise<ProviderMessage[]>;

  /** Initiate a call. */
  makeCall(params: MakeCallParams): Promise<ProviderCall>;

  /** Verify inbound webhook. */
  verifyWebhook(input: { signature: string | null; rawBody: string }): Promise<VNWebhookEvent | null>;
}
