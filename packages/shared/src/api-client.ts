/**
 * Shared API client — used by both web and mobile to talk to the RoamLink backend.
 *
 * Web uses the existing `src/lib/api-client.ts` (which is Next.js-aware).
 * Mobile uses this client with a configurable base URL.
 *
 * The API contract is identical — same endpoints, same DTOs.
 */

import type {
  AuthUser,
  PublicPlan,
  DestinationPage,
  ESIM,
  Order,
  TopUpPackage,
  UsageSample,
  CompatibilityResult,
  EdgeObservationBatch,
  EdgeObservationAck,
  EdgeDeviceRegistration,
  EdgePolicyContext,
} from "./index";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export class RoamLinkClient {
  constructor(private baseUrl: string = "") {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new ApiError(res.status, data?.error ?? "Something went wrong", data?.code);
    }
    return data as T;
  }

  // --- Auth ---
  async login(email: string, password: string) {
    return this.request<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  async joinWaitlist(email: string, name?: string) {
    return this.request<{ id: string; status: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, name }),
    });
  }

  async me(token: string) {
    return this.request<{ user: AuthUser | null }>("/api/auth/me", {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async logout(token: string) {
    return this.request<{ ok: true }>("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  // --- Plans & destinations ---
  async getPlans(params?: { country?: string; region?: string; search?: string; sort?: string }) {
    const qs = new URLSearchParams();
    if (params?.country) qs.set("country", params.country);
    if (params?.region) qs.set("region", params.region);
    if (params?.search) qs.set("search", params.search);
    if (params?.sort) qs.set("sort", params.sort);
    return this.request<{ plans: PublicPlan[]; destinations: { country: string; countryCode: string; region: string; planCount: number; minPriceMinor: number }[]; regions: string[]; countries: { country: string; countryCode: string }[] }>(`/api/plans?${qs}`);
  }

  async getPlan(id: string) {
    return this.request<{ plan: PublicPlan }>(`/api/plans/${id}`);
  }

  // --- Orders ---
  async createOrder(token: string, planId: string, idempotencyKey: string) {
    return this.request<{ order: Order; idempotencyKey: string }>("/api/orders", {
      method: "POST",
      body: JSON.stringify({ planId, idempotencyKey }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async getOrder(token: string, orderId: string) {
    return this.request<{ order: Order }>(`/api/orders/${orderId}`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async listOrders(token: string) {
    return this.request<{ orders: Order[] }>("/api/orders", {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  // --- Payments ---
  async initiatePayment(token: string, orderId: string, idempotencyKey: string) {
    return this.request<{
      paymentReference: string;
      idempotencyKey: string;
      nextAction?: { type: string; url?: string; instructions?: string };
      providerId: string;
    }>("/api/payments", {
      method: "POST",
      body: JSON.stringify({ orderId, idempotencyKey }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async confirmPayment(token: string, orderId: string, paymentReference: string, idempotencyKey: string) {
    return this.request<{ status: string; esimId: string | null; paymentStatus: string }>("/api/payments/confirm", {
      method: "POST",
      body: JSON.stringify({ orderId, paymentReference, idempotencyKey }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  // --- eSIMs ---
  async listESIMs(token: string) {
    return this.request<{ esims: ESIM[] }>("/api/esims", {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async getESIM(token: string, id: string) {
    return this.request<{ esim: ESIM }>(`/api/esims/${id}`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async simulateUsage(token: string, esimId: string, usedMB: number) {
    return this.request<{ result: { dataRemainingMB: number; status: string } }>(`/api/esims/${esimId}/usage`, {
      method: "POST",
      body: JSON.stringify({ usedMB }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async getTopUpPackages(token: string, esimId: string) {
    return this.request<{ packages: TopUpPackage[] }>(`/api/esims/${esimId}/topups`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async purchaseTopUp(token: string, esimId: string, packageId: string, idempotencyKey: string) {
    return this.request<{ topUpId: string; newRemainingMB: number }>("/api/esims/" + esimId + "/topups", {
      method: "POST",
      body: JSON.stringify({ packageId, idempotencyKey }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  // --- Installation ---
  async createInstallToken(token: string, esimId: string) {
    return this.request<{ token: string; expiresAt: string }>(`/api/esims/${esimId}/install-token`, {
      method: "POST",
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async consumeInstallToken(token: string, installToken: string) {
    return this.request<{ esim: { esimId: string; iccid: string | null; smdpAddress: string | null; activationCode: string | null; matchId: string | null; qrCode: string | null; country: string; planName: string } }>(`/api/install/${installToken}`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  // --- Compatibility ---
  async checkCompatibility(device: string) {
    return this.request<{ found: boolean; result?: CompatibilityResult; message?: string }>(`/api/compatibility?device=${encodeURIComponent(device)}`);
  }

  // --- Virtual Numbers ---
  async getVNCountries() {
    return this.request<{ countries: NumberCountry[] }>("/api/virtual-numbers/search");
  }

  async searchVNNumbers(params: { countryCode?: string; smsRequired?: boolean; voiceRequired?: boolean }) {
    const qs = new URLSearchParams();
    if (params.countryCode) qs.set("country", params.countryCode);
    if (params.smsRequired) qs.set("sms", "true");
    if (params.voiceRequired) qs.set("voice", "true");
    return this.request<{ numbers: ProviderNumber[] }>(`/api/virtual-numbers/search?${qs}`);
  }

  async purchaseNumber(token: string, providerNumberId: string, idempotencyKey: string) {
    return this.request<{ orderId: string; virtualNumberId: string; status: string }>("/api/virtual-numbers/orders", {
      method: "POST",
      body: JSON.stringify({ providerNumberId, idempotencyKey }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async listNumbers(token: string) {
    return this.request<{ numbers: VirtualNumber[] }>("/api/virtual-numbers", {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async getNumber(token: string, id: string) {
    return this.request<{ number: VirtualNumber & { messages?: Message[]; calls?: Call[] } }>(`/api/virtual-numbers/${id}`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async releaseNumber(token: string, id: string) {
    return this.request<{ ok: true }>(`/api/virtual-numbers/${id}/release`, {
      method: "POST",
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async sendSMS(token: string, vnId: string, to: string, body: string) {
    return this.request<{ message: Message }>(`/api/virtual-numbers/${vnId}/messages`, {
      method: "POST",
      body: JSON.stringify({ to, body }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async getMessages(token: string, vnId: string) {
    return this.request<{ messages: Message[] }>(`/api/virtual-numbers/${vnId}/messages`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async getCalls(token: string, vnId: string) {
    return this.request<{ calls: Call[] }>(`/api/virtual-numbers/${vnId}/calls`, {
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  // --- Phase 9.1: Edge Observation ---
  // The mobile agent uploads connectivity observations. The server derives
  // authoritative measurements/health/decisions — the client never submits
  // health scores or decisions.

  async registerEdgeDevice(token: string, registration: Omit<EdgeDeviceRegistration, "registeredAt">) {
    return this.request<{ deviceId: string; registered: boolean }>("/api/v1/connectivity/edge/devices", {
      method: "POST",
      body: JSON.stringify(registration),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async uploadEdgeObservations(token: string, batch: EdgeObservationBatch) {
    return this.request<EdgeObservationAck>("/api/v1/connectivity/edge/observations", {
      method: "POST",
      body: JSON.stringify(batch),
      headers: { Cookie: `esim_session=${token}` },
    });
  }

  async updateEdgePolicyContext(token: string, deviceId: string, context: EdgePolicyContext) {
    return this.request<{ ok: true }>("/api/v1/connectivity/edge/policy-context", {
      method: "POST",
      body: JSON.stringify({ deviceId, context }),
      headers: { Cookie: `esim_session=${token}` },
    });
  }
}

export const roamlinkClient = new RoamLinkClient();
