# RoamLink OS — Commercial Architecture Audit

**Auditor:** Principal Architect
**Baseline:** `3fb56a9` (Phase 4 complete)
**Date:** Current session
**Scope:** Commercial readiness of "RoamLink OS: the operating system for connectivity resellers"

---

## Executive Summary

The **connectivity kernel** (entitlement, provisioning, adapter contract, lease, convergence, recovery) is **excellent** — it's the most hardened part of the system, proven through 2C.4.5–2C.4.9 with genuine concurrent tests.

The **commerce layer** (Phase 3: catalog, orders, checkout) and **ranking engine** (Phase 4: normalized offers, deterministic scoring) are **structurally sound but commercially incomplete**. There are critical gaps in payment integration, financial ledger wiring, reseller onboarding, and security that **block revenue generation**.

**Verdict:** The architecture *can* support the business, but is not yet *ready* to. The kernel is over-engineered relative to the commerce layer's under-implementation. The fastest path to revenue requires closing 5 specific gaps — not adding features.

---

## 1. Business Capability Assessment

### 1.1 Multi-tenant reseller SaaS — ✅ Model exists, ⚠️ Onboarding missing

**What exists:**
- `Tenant` model with `slug`, `customDomain`, `brandName`, `brandColor`, `apiKey`
- `TenantSubscription` with SaaS plan, billing cycle, payment provider
- `SaaasPlan` with `monthlyPriceMinor`, `platformFeePercent`, `perOrderFeeMinor`
- `TenantUser` with role-based access (owner/admin/sales/support/billing/operations/viewer)
- `TenantBalance` with prepaid balance, deposit tracking
- `requireTenantContext()` auth guard on most API routes

**What's missing:**
- **No reseller self-service onboarding flow.** `createTenant()` exists in `src/lib/tenant/service.ts` but there's no public API route or UI for a new reseller to sign up. Every tenant is created manually.
- **No trial signup.** `SaaasPlan` has `trialEndsAt` on the subscription but no signup flow populates it.
- **No tenant creation API route** — only the internal service function.

**Revenue impact:** HIGH. Without self-service onboarding, every new reseller requires manual setup. This caps growth at ~1 reseller/week.

### 1.2 MikroTik operator management — ✅ Adapter exists, ⚠️ Operator UI missing

**What exists:**
- `MikroTikConnectivityAdapter` (frozen, 2C.3–2C.4)
- `ConnectivityProviderInstance` model for router endpoints
- `FetchRouterOSTransport` with real RouterOS REST API support
- Fail-closed client resolution (no default fallback)
- `createProviderInstance()` service function

**What's missing:**
- **No operator UI to add/manage routers.** The `ConnectivityProviderInstance` is created via service function only — no API route, no portal page.
- **No router health dashboard.** The adapter has `reconcile()` but there's no UI showing router status.
- **No hotspot management UI.** Operators can't see their hotspots, active sessions, or usage.

**Revenue impact:** MEDIUM. An operator who can't add their router through the UI can't use the platform.

### 1.3 Telco reseller integrations — ⚠️ Model supports it, no integration exists

**What exists:**
- `ConnectivityOffer2` supports `providerType: "telco"` and `supplierId`
- `ingestTelcoProduct()` function in supplier-feed.ts
- `Supplier` model (legacy, from B2C era)

**What's missing:**
- **No actual telco adapter.** The `telco` provider type is supported by the ranking engine but there's no `TelcoProviderClient` or `TelcoConnectivityAdapter`.
- **No telco API integration.** No client for any real telco API (e.g., MTN, Airtel, Vodafone APIs).
- **No telco product import flow.** `ingestTelcoProduct()` exists but is never called from an API route.

**Revenue impact:** LOW (for MVP). Telco resellers are a Phase 5+ opportunity. The architecture supports them; the integration doesn't exist yet.

### 1.4 eSIM suppliers — ✅ Adapter exists, ⚠️ No live supplier connected

**What exists:**
- `EsimConnectivityAdapter` (Phase 2C.5)
- `EsimSupplierClient` with GET-first + CONFLICT convergence
- `FetchEsimTransport` for real eSIM supplier REST APIs
- `MockEsimTransport` for testing
- `esimProductionAsyncResolver` — fail-closed, reads `ESIM_SUPPLIER_ENDPOINT` + `ESIM_SUPPLIER_API_KEY` env vars

**What's missing:**
- **No live eSIM supplier connected.** The adapter is ready but no real supplier (Airalo, Soracom, Truphone) is integrated.
- **No eSIM product catalog import.** The supplier feed ingestion (`ingestSupplierFeed()`) exists but is never called from an API route or cron.
- **No eSIM activation flow.** The customer gets an ICCID but there's no QR code display or activation link.

**Revenue impact:** MEDIUM. eSIM is a secondary product line (the primary is WiFi). But it's the differentiator that makes RoamLink more than "WiFi billing software."

### 1.5 Local WiFi zones — ✅ Fully supported

**What exists:**
- `MikroTikConnectivityAdapter` handles hotspot user CRUD
- `ConnectivityOffer2` with `capabilityType: INTERNET` and `coverage` (cities, geo-radius)
- `ingestOwnInfrastructure()` for WiFi operators publishing their own plans
- Ranking engine scores location match (country/region/city/geo-radius)

**What's missing:**
- **No zone/hotspot group model.** A WiFi operator with 50 routers can't group them into zones (e.g., "Accra CBD", "East Legon"). The `ConnectivityProviderInstance` is per-router, not per-zone.

**Revenue impact:** LOW. The current per-router model is sufficient for MVP.

### 1.6 Connectivity offer marketplace — ⚠️ Ranking exists, marketplace doesn't

**What exists:**
- `ConnectivityOffer2` normalized offers
- `rankOffers()` deterministic ranking engine
- `ResellerMarkup` rules
- `ConnectivityIntent` with stored ranked results

**What's missing:**
- **No marketplace UI.** The ranking API exists (`POST /api/commerce/rank`) but there's no customer-facing page that lets a customer express their intent and see ranked offers.
- **No offer → product → checkout flow.** A ranked offer has `resellerProductId` (nullable) but there's no flow to go from a ranked offer to checkout.
- **No supplier directory.** Resellers can't browse available suppliers and their wholesale rates.

**Revenue impact:** MEDIUM. The marketplace is the "AWS Marketplace" analog — it's the supply aggregation layer. But it's not needed for the first 3 resellers.

### 1.7 Customer intent routing — ✅ Engine exists, ⚠️ Not wired to UI

**What exists:**
- `rankOffers(intent, weights)` — pure deterministic function
- 6 scoring dimensions (intent match, location, availability, price, margin, reliability)
- `ConnectivityIntent` persisted with ranked results

**What's missing:**
- **No intent input UI.** No customer-facing page where a customer says "I need internet in Accra, 50Mbps, under $20/month."
- **No intent → offer → checkout flow.** The ranking engine returns offers but there's no next step.

**Revenue impact:** MEDIUM. Intent routing is the differentiator but not the MVP.

### 1.8 Provider-independent provisioning — ✅ Excellent

**What exists:**
- `ConnectivityProviderAdapter` contract (frozen)
- `provisionBinding()` — supplier-neutral, works for MikroTik + eSIM with zero kernel changes
- `reconcileProvisioning()` — canonical recovery worker
- Lease + ownership fencing + convergence + claim-guarded finalization
- Proven by genuine concurrent tests (2C.4.7)

**What's missing:**
- Nothing. This is the strongest part of the system.

**Revenue impact:** NONE (it's already done).

---

## 2. Architecture Gaps

### GAP-1: No payment integration in checkout (P0 — blocks revenue)

**Current state:** The checkout flow (`/checkout/[productId]`) **simulates payment**. The `fulfill` API route marks the order as "paid" with `paymentRef: sim-${Date.now()}` and calls `fulfillOrder()` immediately. No real payment is processed.

**What's needed:**
- Stripe/Paystack payment intent creation in the checkout flow
- Webhook handler that marks the order "paid" on real payment confirmation
- The webhook calls `fulfillOrder()` after marking paid

**Risk:** Without this, the platform cannot collect a single dollar. This is the #1 revenue blocker.

### GAP-2: No financial ledger wiring in fulfillment (P0 — financial integrity)

**Current state:** `fulfillOrder()` in `src/lib/commerce/fulfillment.ts` creates an entitlement and provisions a resource, but **does not post any ledger entries**. I verified this: `rg "ledger\|postLedger" src/lib/commerce/fulfillment.ts` returns zero matches.

The double-entry ledger exists (`src/lib/finance/double-entry-ledger.ts` with `postLedgerTransaction`, `ledgerCustomerPayment`, `ledgerResellerPurchase`, `ledgerProviderPurchase`, `ledgerPaymentFee`) but the fulfillment flow doesn't call any of these.

**What's needed:**
- On payment confirmation: `ledgerCustomerPayment()` (customer pays reseller)
- On fulfillment: `ledgerResellerPurchase()` (reseller pays supplier, if supplier offer)
- On fulfillment: `ledgerProviderPurchase()` (reseller pays provider for usage)
- Platform fee: `ledgerPaymentFee()` (RoamLink's cut)

**Risk:** Without ledger wiring, there's no financial audit trail. Revenue is untrackable. This is a financial integrity P0.

### GAP-3: No reseller onboarding flow (P1 — blocks growth)

**Current state:** `createTenant()` exists as a service function but there's no public API route or UI. Every tenant is created manually by a developer.

**What's needed:**
- `POST /api/onboarding/tenant` — public route for reseller signup
- Onboarding UI: reseller enters name, email, brand → creates tenant + user + trial subscription
- Trial flow: `SaaasPlan` trial for 14 days, then requires payment

**Risk:** Without self-service onboarding, growth is capped at the rate a human can manually provision tenants.

### GAP-4: Unauthenticated customer creation API (P1 — security)

**Current state:** `POST /api/commerce/customer` has **no authentication check**. Anyone can create users by posting `{ email, name, tenantId }`. The `tenantId` is taken from the request body, not from the authenticated session.

**What's needed:**
- The customer creation route must verify the caller has access to the specified `tenantId`
- OR: the checkout flow should create the customer via an authenticated server-side call, not a public API

**Risk:** An attacker could create arbitrary user accounts, spam the system, or impersonate customers. This is a security P1.

### GAP-5: No provider instance management UI/API (P1 — operator onboarding)

**Current state:** `ConnectivityProviderInstance` is created via `createProviderInstance()` service function. There's no API route and no portal page for an operator to add their MikroTik router or eSIM supplier.

**What's needed:**
- `POST /api/connectivity/instances` — create a provider instance (auth-guarded)
- Portal page: "Add Router" form (endpoint, credentials via configurationKey)
- Portal page: "Add eSIM Supplier" form (API key)

**Risk:** An operator who can't add their router through the UI can't use the platform.

### GAP-6: No reconciliation cron for offers (P2 — data quality)

**Current state:** `reconcileProvisioning()` exists for bindings, and there's an internal reconcile route (`/api/internal/connectivity-reconcile`). But there's no cron that:
- Updates `ConnectivityOffer2.reliabilityScore` based on provisioning success/failure
- Marks expired offers as `expired`
- Re-ingests supplier feeds periodically

**What's needed:**
- A cron job that runs `reconcileProvisioning()` for all BOUND bindings
- Updates offer reliability scores based on recent provisioning outcomes
- Marks offers past `validUntil` as `expired`

**Risk:** Without this, offer reliability scores stay at 0.5 forever, and the ranking engine can't learn from actual provisioning outcomes.

### GAP-7: No offer → product → checkout flow (P2 — marketplace readiness)

**Current state:** `ConnectivityOffer2` has a `resellerProductId` field (nullable) but there's no flow to create a `ResellerProduct` from a ranked offer and link them.

**What's needed:**
- "Create product from offer" action in the portal
- The ranked offers page links to checkout for each offer

**Risk:** The ranking engine produces offers but customers can't buy them directly. They have to go through the product catalog, which may not include all offers.

### GAP-8: Legacy model collision (P3 — technical debt)

**Current state:** The schema has both the legacy `ConnectivityProduct`/`Supplier`/`ConnectivityOffer` models (from the B2C eSIM marketplace era) and the new `ResellerProduct`/`ConnectivityOffer2` models. This is confusing and could lead to queries hitting the wrong table.

**What's needed:**
- A migration that either merges the legacy models into the new ones or archives them

**Risk:** Low, but it's a maintainability issue.

---

## 3. Missing Domain Models

| Model | Purpose | Priority |
|-------|---------|----------|
| `HotspotZone` | Group multiple MikroTik routers into a zone (e.g., "Accra CBD") | P3 |
| `SupplierFeedConfig` | Configuration for periodic supplier feed ingestion (cron schedule, API endpoint) | P2 |
| `PayoutAccount` | Reseller's payout account for collecting customer payments (Stripe Connect account ID, bank account) | P1 |
| `TaxRate` | Tax rates by jurisdiction for customer invoices | P2 |
| `Refund` | Refund records linked to CustomerOrder | P2 |
| `WebhookEvent` | Idempotency for incoming webhooks (Stripe/Paystack) — prevents duplicate processing | P0 |

---

## 4. Missing APIs

| API | Purpose | Priority |
|-----|---------|----------|
| `POST /api/onboarding/tenant` | Reseller self-service signup | P1 |
| `POST /api/connectivity/instances` | Create provider instance (add router/eSIM supplier) | P1 |
| `GET /api/connectivity/instances` | List provider instances for the tenant | P1 |
| `POST /api/commerce/checkout/initiate` | Create a payment intent (Stripe/Paystack) | P0 |
| `POST /api/webhooks/commerce/[provider]` | Webhook for commerce payment confirmation → fulfillOrder | P0 |
| `GET /api/commerce/offers` | List ranked offers for the tenant (for marketplace UI) | P2 |
| `POST /api/commerce/offers/[offerId]/publish` | Create a ResellerProduct from a ranked offer | P2 |
| `GET /api/commerce/usage` | Usage data for dashboards | P2 |

---

## 5. Security Risks

| Risk | Severity | Details |
|------|----------|---------|
| **Unauthenticated customer creation** | HIGH | `POST /api/commerce/customer` has no auth check. Anyone can create users in any tenant. |
| **No rate limiting on checkout** | MEDIUM | The checkout flow has no rate limiting. An attacker could spam orders. |
| **No CSRF protection on commerce APIs** | MEDIUM | The commerce API routes don't appear to use CSRF tokens. |
| **Provider credentials in env vars** | LOW | `ESIM_SUPPLIER_API_KEY` is an env var, not a secrets manager. Acceptable for MVP but not production. |
| **No audit log for commerce operations** | MEDIUM | Order creation, fulfillment, and markup changes aren't logged to an audit trail. |

---

## 6. Financial Risks

| Risk | Severity | Details |
|------|----------|---------|
| **No ledger entries on fulfillment** | CRITICAL | `fulfillOrder()` doesn't call any ledger functions. Revenue is untrackable. |
| **No payment provider integration** | CRITICAL | Checkout simulates payment. No real money flows. |
| **No refund flow** | HIGH | There's no way to refund a customer. The `CustomerOrder` status includes "refunded" but no API or flow triggers it. |
| **No payout to resellers** | HIGH | There's no flow for resellers to withdraw their earnings. `TenantBalance` tracks the balance but there's no payout API. |
| **No tax handling** | MEDIUM | No tax calculation or collection on customer payments. |
| **No platform fee collection** | MEDIUM | `SaaasPlan.platformFeePercent` exists but is never applied to transactions. |

---

## 7. Scalability Risks

| Risk | Severity | Details |
|------|----------|---------|
| **Ranking engine loads all offers** | MEDIUM | `rankOffers()` fetches ALL active offers for a tenant with `findMany()`. For a tenant with 10,000 offers, this will be slow. Needs pagination or pre-filtering by capability/location. |
| **No caching layer** | MEDIUM | No Redis or in-memory cache. Every API call hits the database. |
| **Neon serverless Postgres** | LOW | Neon has cold-start latency (~3s). Acceptable for MVP but will need a connection pooler for production scale. |
| **No background job queue** | MEDIUM | `fulfillOrder()` runs synchronously in the request. For slow providers (eSIM supplier with 10s API calls), this will timeout. Needs a background worker (BullMQ, Inngest, or similar). |
| **No CDN for portal assets** | LOW | Portal assets are served by Next.js. A CDN (Vercel's is built-in) will be needed for global performance. |

---

## 8. Migration Plan (Prioritized)

### Priority 1: Revenue Generation (2–3 weeks)

**Goal:** First paying customer.

| Step | What | Why |
|------|------|-----|
| 1.1 | Wire Stripe/Paystack into checkout | Can't collect money without it |
| 1.2 | Add webhook handler for payment confirmation → fulfillOrder | Connects payment to provisioning |
| 1.3 | Wire ledger entries into fulfillment | Financial audit trail |
| 1.4 | Fix unauthenticated customer creation API | Security P1 |
| 1.5 | Add `WebhookEvent` model for idempotent webhook processing | Prevents duplicate fulfillment |

### Priority 2: Operator Onboarding (2–3 weeks)

**Goal:** A WiFi operator can sign up, add their router, create a product, and sell — without developer intervention.

| Step | What | Why |
|------|------|-----|
| 2.1 | Reseller self-service onboarding (`POST /api/onboarding/tenant` + UI) | Removes manual tenant creation |
| 2.2 | Provider instance management API + portal UI | Operators can add their own routers |
| 2.3 | Trial subscription flow (14-day trial → payment) | Lowers signup friction |
| 2.4 | Platform fee collection on transactions | RoamLink revenue |

### Priority 3: Payment Flows (1–2 weeks)

**Goal:** Complete payment lifecycle.

| Step | What | Why |
|------|------|-----|
| 3.1 | Refund flow (API + webhook) | Customer service capability |
| 3.2 | Payout to resellers (Stripe Connect or manual) | Resellers can withdraw earnings |
| 3.3 | Tax rate model + calculation | Compliance |

### Priority 4: Supply Aggregation (2–3 weeks)

**Goal:** Multiple suppliers connected, offers automatically ingested.

| Step | What | Why |
|------|------|-----|
| 4.1 | `SupplierFeedConfig` model + cron for periodic ingestion | Automated offer refresh |
| 4.2 | Connect first real eSIM supplier (Airalo or similar) | Proves the eSIM path |
| 4.3 | Offer reliability score reconciliation cron | Ranking engine learns from outcomes |
| 4.4 | Offer → product → checkout flow | Customers can buy ranked offers directly |

### Priority 5: Marketplace Readiness (3–4 weeks)

**Goal:** The "AWS Marketplace" experience.

| Step | What | Why |
|------|------|-----|
| 5.1 | Customer-facing marketplace UI (intent input → ranked offers) | The differentiation experience |
| 5.2 | Supplier directory (browse suppliers + wholesale rates) | Supply discovery |
| 5.3 | Background job queue for fulfillment | Handles slow providers without timeouts |
| 5.4 | Ranking engine pre-filtering (by capability + location) | Scales beyond 1000 offers |
| 5.5 | Legacy model cleanup (merge ConnectivityProduct → ResellerProduct) | Technical debt reduction |

---

## 9. What's Excellent (Do Not Touch)

| Area | Assessment |
|------|-----------|
| **Connectivity kernel** (entitlement, provisioning, lease, convergence) | Excellent. The most hardened part of the system. Proven by genuine concurrent tests. |
| **Provider adapter contract** | Excellent. Supplier-neutral, frozen, works for MikroTik + eSIM with zero kernel changes. |
| **Recovery worker** (`reconcileProvisioning`) | Excellent. Canonical, idempotent, handles all crash scenarios. |
| **Ranking engine** | Good. Deterministic, well-tested, supplier-neutral. Needs optimization for scale but architecturally correct. |
| **Markup engine** | Good. Scoped resolution is correct. Needs UI but the logic is sound. |
| **Double-entry ledger** | Good. Comprehensive function set. Just not wired to the fulfillment flow (GAP-2). |
| **SaaS billing kernel** (2B.3.x) | Good. Frozen, handles reseller subscription lifecycle. |

---

## 10. Final Assessment

**Can the current architecture support "RoamLink OS"?**

**Yes — but not yet.** The architecture is structurally correct. The kernel is over-built (in a good way). The commerce layer is under-built relative to the kernel. The gap between "what the kernel can do" and "what the commerce layer actually does" is the risk.

**The 5 things that must happen before revenue:**

1. **Wire payment into checkout** (GAP-1) — 3 days
2. **Wire ledger into fulfillment** (GAP-2) — 2 days
3. **Fix customer API auth** (GAP-4) — 1 day
4. **Add reseller onboarding** (GAP-3) — 5 days
5. **Add provider instance UI** (GAP-5) — 3 days

**Total: ~2 weeks to first paying customer.**

The ranking engine, marketplace, and supply aggregation are Phase 5+. They're architecturally ready but not commercially necessary for the first 3 resellers. The first 3 resellers are WiFi operators who need: signup → add router → create product → sell. That's Priorities 1 + 2.

**The kernel is the crown jewel. The commerce layer is the revenue path. Close the 5 gaps and RoamLink OS is ready for its first paying reseller.**
