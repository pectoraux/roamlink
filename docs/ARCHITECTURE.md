# RoamLink — Connectivity Operating System: Architecture & Roadmap

**Author:** Chief Architect
**Status:** Design proposal
**Kernel baseline:** `e6fb09f` (2C.4.9 frozen + eSIM supplier)

---

## 0. Executive Summary

RoamLink is not an eSIM marketplace. It is a **connectivity operating system**: a single entitlement, billing, and provisioning layer that any reseller (WiFi ISP, fixed wireless, eSIM retailer, future satellite/LPWAN) can plug into and sell connectivity under their own brand.

The frozen kernel (2C.4.5–2C.4.9) is correct and preserved. What's missing is not more concurrency hardening — it is a **commercial layer** on top: a reseller business model, a catalog that doesn't assume one provider type, and a path to revenue that doesn't require building a consumer-facing app.

The fastest path to revenue is a **B2B reseller SaaS**: sell the platform to 3–5 local ISPs and WiFi operators in Ghana who already have customers but lack the billing/provisioning glue. They pay a platform fee + per-transaction. We don't compete with them; we power them.

---

## 1. Challenge the Business Assumptions

### 1.1 "We are building an eSIM marketplace"

**Wrong.** An eSIM marketplace is a consumer-facing B2C play with high CAC, low margins (eSIM wholesale rates are thin), and competition from Airalo, Maya, Soracom. RoamLink's differentiator is not "another place to buy eSIMs" — it is the **unified entitlement layer** that makes a reseller's life easier.

### 1.2 "We need a consumer app"

**Not first.** A consumer app is a distribution channel, not a product. The product is the operating system. The first distribution channel should be **resellers who already have customers** — they bring the demand, we bring the infrastructure.

### 1.3 "We need to build all providers ourselves"

**No.** We build the kernel + the first two adapters (MikroTik for WiFi/ISP, eSIM for roaming). Future providers (Starlink, LoRaWAN, cellular MVNOs) are partner-built adapters against the published `ConnectivityProviderAdapter` contract. We are a platform, not an integrator shop.

### 1.4 "We need to handle payments ourselves"

**We already do** (Stripe, Paystack, Flutterwave are integrated). But the reseller's customers pay the **reseller**, not RoamLink. RoamLink bills the **reseller** (platform fee + usage). The reseller's payment flow is their business; we provide the ledger.

### 1.5 "The reseller model is complex"

**It is, but it's already half-built.** The SaaS billing kernel (2B.3.x) handles tenant subscriptions. The reseller control plane (tests reference `phase2b-reseller-control-plane`) exists. The gap is connecting reseller subscriptions → connectivity entitlements → provider bindings, which the frozen kernel already does.

---

## 2. The Core Insight: One Entitlement, Many Providers

```
┌─────────────────────────────────────────────────┐
│                 Reseller (Tenant)                │
│  "Accra WiFi" — has customers, needs billing    │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│            ConnectivityEntitlement              │
│  "Customer Jane gets 50Mbps for 30 days"        │
│  (provider-neutral — the reseller doesn't      │
│   care if it's WiFi or eSIM)                    │
└──────────────────────┬──────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ MikroTik │ │   eSIM   │ │ Future   │
    │ (WiFi)   │ │ (Roaming)│ │ (Satellite)│
    └──────────┘ └──────────┘ └──────────┘
```

The entitlement is the **commercial truth**: what the customer bought. The binding is the **infrastructure truth**: where it's provisioned. The reseller only sees the entitlement. The kernel mediates between the two.

---

## 3. Domain Model

### 3.1 Core Entities (existing — preserved)

| Entity | Purpose | Status |
|--------|---------|--------|
| `Tenant` | A reseller (WiFi ISP, eSIM retailer, etc.) | ✅ exists |
| `TenantSubscription` | Reseller's SaaS subscription to RoamLink | ✅ exists (FROZEN) |
| `ConnectivityCapability` | What kind of connectivity (INTERNET, ROAMING, etc.) | ✅ exists |
| `ConnectivityEntitlement` | A customer's right to connectivity | ✅ exists (FROZEN) |
| `ProviderResourceBinding` | The provisioned resource at a provider | ✅ exists (FROZEN) |
| `ConnectivityProviderInstance` | A specific infrastructure endpoint | ✅ exists |
| `ConnectivityProviderAdapter` | The contract all providers implement | ✅ exists (FROZEN) |

### 3.2 New Entities (minimal additions)

#### `ConnectivityProduct` (the catalog entry)
```
model ConnectivityProduct {
  id              String   @id @default(cuid())
  tenantId        String   // owned by a reseller
  name            String   // "Accra WiFi 50Mbps Monthly"
  capabilityType  String   // INTERNET | ROAMING | LOCAL_NETWORK
  providerType    String   // mikrotik | esim | (null = reseller chooses)
  pricingModel    String   // FLAT | USAGE_BASED | TIERED
  priceMinor      Int      // in currency minor units
  currency        String
  billingCycle    String   // monthly | one_time | prepaid
  capabilitySet   String   // JSON: { downloadMbps, dataLimitBytes, ... }
  status          String   @default("active") // active | archived
}
```

This is the **only new commercial entity**. It connects the reseller's catalog to the entitlement kernel. The reseller creates products; customers buy products; each purchase creates a `ConnectivityEntitlement` via the existing `createEntitlement()`.

#### `CustomerOrder` (the purchase)
```
model CustomerOrder {
  id          String   @id @default(cuid())
  tenantId    String
  customerId  String   // the reseller's end customer
  productId   String
  entitlementId String? // created on fulfillment
  status      String   @default("pending") // pending | fulfilled | failed
  paidAmountMinor Int
  currency    String
}
```

This replaces the existing reseller order model with a connectivity-specific one. It's thin — the heavy lifting is in the entitlement kernel.

### 3.3 What is NOT added

- No new billing kernel (the SaaS billing kernel is FROZEN and handles reseller subscriptions)
- No new payment provider (Stripe/Paystack/Flutterwave are integrated)
- No new adapter contract (the existing `ConnectivityProviderAdapter` is FROZEN)
- No new provisioning state machine (the binding lifecycle is FROZEN)
- No `claimOwner`, `workerId`, `fencingEpoch`, or other distributed-systems fields (the auditor confirmed these are unnecessary)

---

## 4. Provider Model

### 4.1 The Adapter Contract (FROZEN — do not touch)

```typescript
interface ConnectivityProviderAdapter {
  readonly providerType: string;
  provision(input): Promise<ProvisionResult>;
  suspend(input): Promise<ActionResult>;
  resume(input): Promise<ActionResult>;
  release(input): Promise<ActionResult>;
  getUsage(input): Promise<UsageMetrics | undefined>;
  reconcile(input): Promise<ReconciliationResult>;
}
```

Every provider — current and future — implements this. The kernel never knows the provider type.

### 4.2 Provider Tiers

| Tier | Provider type | Status | Revenue model |
|------|--------------|--------|---------------|
| **Tier 1 (shipping)** | MikroTik (WiFi/ISP) | ✅ adapter + mock tests | Reseller pays platform fee; MikroTik is their own infra |
| **Tier 1 (shipping)** | eSIM supplier | ✅ adapter + mock tests | Reseller pays platform fee + eSIM wholesale (passed through) |
| **Tier 2 (partner-built)** | Starlink, cellular MVNO | Future | Partner builds adapter against published contract |
| **Tier 3 (community)** | LoRaWAN, community mesh | Future | Open-source adapters |

### 4.3 The Provider Marketplace (future, not now)

Once 3+ adapters exist, publish the adapter SDK. Partners self-register. This is a **platform play**, not a build-everything-ourselves play. Do not build the marketplace UI until there are 3+ adapters and 5+ resellers asking for it.

---

## 5. SaaS Strategy

### 5.1 Pricing (simple, defensible)

```
Platform fee:     $49/month per reseller (includes 1,000 entitlements)
Per-entitlement:  $0.10/active entitlement/month (after the first 1,000)
Usage passthrough: 0% markup (reseller pays the provider's wholesale rate directly)
Payment processing: passthrough (reseller's Stripe/Paystack account)
```

**Why this works:**
- Low entry barrier ($49/mo) for small ISPs
- Scales with the reseller's success (per-entitlement)
- We don't take a cut of the reseller's revenue (no margin conflict)
- We don't touch the reseller's customer payments (no KYC/PCI burden for us)

### 5.2 What the reseller gets

1. **Catalog management** — create products (WiFi plans, eSIM data packs) in a UI
2. **Customer management** — their customers, their data, their branding
3. **Automated provisioning** — customer buys → entitlement created → resource provisioned (MikroTik hotspot user or eSIM profile)
4. **Billing & ledger** — the frozen SaaS billing kernel handles their subscription lifecycle
5. **Usage tracking** — `getUsage()` from the adapter feeds a usage dashboard
6. **Reconciliation** — the frozen `reconcileProvisioning()` handles crashes automatically
7. **White-label** — their domain, their brand (the `Tenant` model already supports `customDomain`, `brandName`, `brandColor`)

### 5.3 What RoamLink does NOT do

- Does not sell connectivity to consumers (B2B only)
- Does not process end-customer payments (reseller's Stripe/Paystack)
- Does not own the customer relationship (reseller does)
- Does not build consumer apps (reseller can, using our API)

---

## 6. Marketplace Strategy

### 6.1 Not a marketplace — a platform

The word "marketplace" implies RoamLink matches buyers and sellers. It doesn't. RoamLink is the **operating system** that resellers use to run their connectivity business. The reseller is the seller; their customers are the buyers.

### 6.2 The supply side

Providers (MikroTik routers, eSIM suppliers) are **not** sellers on a marketplace. They are **infrastructure** that the reseller connects to. The reseller owns the relationship with the provider (or owns the provider outright, in the WiFi case).

### 6.3 The demand side

Resellers bring demand. RoamLink's job is to make it trivially easy for a new reseller to sign up, connect a provider, create a product, and start selling. The faster that loop, the more resellers.

### 6.4 Future: provider directory

When there are 5+ eSIM suppliers and 3+ satellite providers, a directory helps resellers compare wholesale rates. But this is a **discovery tool**, not a marketplace. The reseller still contracts directly with the provider.

---

## 7. Architecture

### 7.1 System Context

```
┌──────────────────────────────────────────────────────────┐
│                    RoamLink Platform                      │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Reseller   │  │  Catalog /   │  │  Entitlement   │  │
│  │   Portal    │──│  Products    │──│   Kernel       │  │
│  │  (Next.js)  │  │  (new, thin) │  │  (FROZEN)      │  │
│  └─────────────┘  └──────────────┘  └───────┬────────┘  │
│                                            │             │
│  ┌─────────────┐  ┌──────────────┐         │             │
│  │  SaaS       │  │  Payment     │         │             │
│  │  Billing    │  │  (existing)  │         │             │
│  │  (FROZEN)   │  │              │         │             │
│  └─────────────┘  └──────────────┘         │             │
│                                            ▼             │
│                                   ┌────────────────┐     │
│                                   │ Provider        │     │
│                                   │ Registry        │     │
│                                   │ (existing)      │     │
│                                   └───────┬────────┘     │
│                                           │              │
│                          ┌────────────────┼────────┐     │
│                          ▼                ▼        ▼     │
│                    ┌──────────┐  ┌──────────┐  ┌──────┐ │
│                    │ MikroTik │  │  eSIM    │  │Future│ │
│                    └─────┬────┘  └────┬─────┘  └──┬───┘ │
└──────────────────────────┼────────────┼───────────┼─────┘
                           │            │           │
                    ┌──────▼──┐  ┌──────▼──┐  ┌────▼────┐
                    │ Router  │  │ eSIM    │  │ Other   │
                    │ (WiFi)  │  │ Supplier│  │ infra   │
                    └─────────┘  └─────────┘  └─────────┘
```

### 7.2 The Layers (what's frozen, what's new)

| Layer | Status | What it does |
|-------|--------|-------------|
| SaaS billing kernel | **FROZEN** (2B.3.x) | Reseller subscription lifecycle, double-entry ledger, payment reconciliation |
| Entitlement kernel | **FROZEN** (2C.4.9) | Entitlement lifecycle, provisioning lease, claim-guarded finalization, recovery |
| Provider adapter contract | **FROZEN** (2C.1) | The interface all providers implement |
| Provider registry | **FROZEN** (2C.2) | providerType → adapter resolution |
| MikroTik adapter | **FROZEN** (2C.3–2C.4) | WiFi/ISP provisioning |
| eSIM adapter | **NEW** (2C.5) | eSIM supplier provisioning |
| Catalog (Products) | **NEW** (Phase 3) | Reseller creates products |
| Reseller portal | **NEW** (Phase 3) | UI for resellers |
| Customer checkout | **NEW** (Phase 3) | End-customer buys a product |
| Usage dashboard | **NEW** (Phase 4) | Reseller sees usage |
| Live provider validation | **DEFERRED** (2C.4.10/2C.4.11) | Real RouterOS / eSIM endpoint tests |

### 7.3 The Request Flow (customer purchase)

```
1. Customer visits reseller's white-label site
2. Customer selects a ConnectivityProduct
3. Customer pays (reseller's Stripe/Paystack)
4. CustomerOrder created (status: pending)
5. Payment confirmed → createEntitlement(product.capabilitySet)
6. Entitlement ACTIVE → provisionBinding(entitlement)
7. Kernel claims lease → adapter.provision() → resource created at provider
8. Binding BOUND → CustomerOrder fulfilled
9. Customer receives credentials (WiFi password / eSIM QR code)
```

Steps 5–8 are the frozen kernel. Steps 1–4 and 9 are new thin layers.

---

## 8. Implementation Roadmap

### Phase 3 — Commercial Layer (4–6 weeks)

**Goal:** First paying reseller.

#### 3.1 Catalog & Products (1 week)
- Add `ConnectivityProduct` and `CustomerOrder` models to Prisma schema
- API: `POST /api/products`, `GET /api/products`, `POST /api/orders`
- The order API calls `createEntitlement()` (existing) + `provisionBinding()` (existing)

#### 3.2 Reseller Portal (2 weeks)
- Next.js app at `/{tenantSlug}` (white-label via `Tenant.customDomain`)
- Product management UI
- Customer list (read-only from reseller's perspective)
- Entitlement status dashboard (reads from frozen kernel)

#### 3.3 Customer Checkout (1 week)
- Customer-facing page at `/{tenantSlug}/checkout/{productId}`
- Stripe/Paystack integration (existing providers, new checkout flow)
- On payment success → order → entitlement → provisioning

#### 3.4 Credential Delivery (1 week)
- WiFi: email/SMS the hotspot password (from `ProviderResourceBinding.providerMetadata`)
- eSIM: display the QR code / activation link (from eSIM supplier response)

**Deliverable:** One reseller can sign up, create a product, sell to a customer, and the customer gets provisioned WiFi or eSIM.

### Phase 4 — Operations & Scale (4–6 weeks)

#### 4.1 Usage Dashboard
- `getUsage()` from adapters → time-series storage → reseller dashboard
- Alerting on quota thresholds (80%, 95%, 100%)

#### 4.2 Reconciliation Cron
- Periodic `reconcileProvisioning()` for all BOUND bindings
- Handles provider drift (router offline, eSIM expired)

#### 4.3 Multi-provider per reseller
- A reseller can sell BOTH WiFi (MikroTik) and eSIM from the same portal
- The catalog supports multiple `providerType`s
- The customer doesn't care which provider — they buy the product

#### 4.4 Reseller self-service
- Reseller connects their own MikroTik router (provider instance setup UI)
- Reseller connects their own eSIM supplier (API key entry)
- `ConnectivityProviderInstance` is created via UI, not code

### Phase 5 — Platform Expansion (ongoing)

#### 5.1 Live provider validation (2C.4.10/2C.4.11)
- Execute the live RouterOS test harness against a real router
- Execute the eSIM test harness against a real supplier
- Multi-process distributed validation

#### 5.2 Adapter SDK
- Publish the `ConnectivityProviderAdapter` contract as a standalone package
- Documentation: how to build an adapter for Starlink, cellular, LoRaWAN
- Partner self-service registration

#### 5.3 Provider directory (only when 5+ adapters exist)
- Compare wholesale rates
- Reviews / reliability scores
- Not a marketplace — a discovery tool

---

## 9. What to Preserve (the auditor's directive)

### 9.1 The frozen kernel is correct

The 2C.4.5–2C.4.9 arc established a coherent distributed-side-effect architecture:
- Durable lease + attempt identity
- Ownership fencing (pre-provider gate + non-resurrectable heartbeat)
- Provider-side convergence (GET-first, CONFLICT reconciliation)
- Claim-guarded finalization (stale worker = 0 rows)
- ABA-fenced takeover
- Canonical recovery worker (`reconcileProvisioning`)

**Do not modify this.** The eSIM integration (2C.5) proved it's supplier-neutral. The commercial layer builds on top, not inside.

### 9.2 What NOT to add

- Do not add `claimOwner`, `workerId`, `fencingEpoch` — the auditor confirmed these are unnecessary
- Do not add a new billing kernel — the SaaS billing kernel is FROZEN
- Do not add a new adapter contract — the existing one is FROZEN
- Do not build a consumer app first — B2B reseller SaaS is the path to revenue
- Do not build a marketplace UI — it's a platform, not a marketplace

### 9.3 The honest validation gaps

```
MOCK-VALIDATED:     2C.4.5–2C.4.9 (kernel), 2C.5 (eSIM integration)
IMPLEMENTED-NOT-EXECUTED: 2C.4.10A–D (live RouterOS harness)
NOT STARTED:        2C.4.11 (multi-process distributed validation)
```

These remain the validation milestones. They do not block the commercial layer — the commercial layer uses the frozen kernel as-is.

---

## 10. The Fastest Path to Revenue

### 10.1 Target: 3 local ISPs in Ghana in 90 days

Ghana has dozens of small WiFi ISPs (often called "cyber cafés" or "community networks") running MikroTik routers with manual billing. They have:
- Customers (demand)
- Infrastructure (MikroTik routers)
- No billing system (Excel + WhatsApp)
- No self-service portal (customers call to top up)

RoamLink gives them:
- A white-label portal (`theirbrand.roamlink.app` or custom domain)
- Automated billing (Stripe/Paystack — they already use Paystack)
- Automated provisioning (customer pays → hotspot user created automatically)
- Usage tracking and quota enforcement

### 10.2 The pitch

> "Your customers pay online. Your hotspot users are created automatically. You see usage in a dashboard. $49/month."

That's it. No "connectivity operating system" jargon. No eSIM. Just "automated WiFi billing."

### 10.3 The expansion

Once 3 ISPs are paying:
- Add eSIM as a second product type ("now sell roaming data to your customers")
- Add a second provider type (Starlink for backup connectivity)
- Publish the adapter SDK

The kernel doesn't change. The catalog grows. The reseller's business grows.

---

## 11. Summary

| Question | Answer |
|----------|--------|
| What is RoamLink? | A connectivity operating system (B2B SaaS for resellers) |
| What's the fastest path to revenue? | Sell automated WiFi billing to 3 Ghanaian ISPs ($49/mo each) |
| What's frozen? | The entire kernel (entitlement, billing, adapter contract, lease, convergence) |
| What's new? | Catalog (Products), reseller portal, customer checkout — thin layers on top |
| What's deferred? | Live provider validation, multi-process testing, consumer app, marketplace UI |
| What's the provider model? | Adapter contract (FROZEN) — MikroTik + eSIM now, partner-built adapters later |
| What's the SaaS strategy? | Platform fee + per-entitlement, no revenue cut, white-label |
| What's the marketplace strategy? | It's not a marketplace — it's a platform. Resellers own the customer. |

**The kernel is correct. The architecture is a platform. The path to revenue is B2B reseller SaaS. Build the thin commercial layer, sign 3 ISPs, prove the model, then expand.**
