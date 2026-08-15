# RoamLink OS — Phase 6 Architecture Audit & Implementation Roadmap

**Principal Architect**
**Baseline:** `645d3d7` (Commercial Foundation Phase 1 complete)
**Goal:** Transform into a commercially viable connectivity operating system

---

## 1. Architecture Audit

### 1.1 What's Frozen (Do Not Touch)

| Layer | Status | Evidence |
|-------|--------|----------|
| Connectivity kernel (entitlement.ts) | FROZEN | 2,114 lines, 2C.4.5–2C.4.9 proven |
| Provider adapter contract | FROZEN | `ConnectivityProviderAdapter` interface |
| Entitlement system | FROZEN | `ConnectivityEntitlement` + `ProviderResourceBinding` |
| Offer ranking engine | FROZEN | `rankOffers()` deterministic, 6 scoring dimensions |
| Commerce layer | FROZEN | `fulfillOrder()`, `ResellerProduct`, `CustomerOrder` |
| Double-entry ledger | FROZEN | `postLedgerTransaction()` + 9 ledger functions |

### 1.2 What Exists (Reuse, Don't Rebuild)

| Capability | Where | Status |
|-----------|-------|--------|
| Payment integration | `src/lib/payments/` (Paystack/Stripe/Mock) | ✅ Wired in 5.1 |
| Webhook processing | `WebhookEvent` model + `/api/webhooks/commerce/` | ✅ Idempotent |
| Reseller onboarding | `/api/onboarding/tenant` | ✅ Creates user+tenant+trial |
| Provider instance management | `/api/connectivity/instances` | ✅ Auth-guarded |
| Infrastructure portal | `/portal/infrastructure` | ✅ Add/manage routers |
| Checkout flow | `/checkout/[productId]` | ✅ Payment intent → webhook → fulfill |
| Ledger integration | `fulfillment.ts` → `postFulfillmentLedger()` | ✅ 3 idempotent entries |
| TenantBalance | Prepaid wallet model | ✅ Exists, tracks balance |
| TenantTransaction | Transaction history | ✅ Monotonic sequence |
| Organization (B2B) | `Organization` + `OrganizationMember` | ✅ Exists with spend limits |
| CorporateOrder | B2B order linking | ✅ Exists |
| Provider credit | `src/lib/finance/provider-credit.ts` | ✅ Credit accounts, commitments |
| ConnectivityIntent | Intent model with ranked results | ✅ Exists from Phase 4 |
| ConnectivityOffer2 | Normalized offers | ✅ Exists from Phase 4 |
| ResellerMarkup | Markup rules | ✅ 8-level resolution |
| Ranking engine | `rankOffers()` | ✅ Deterministic, 6 dimensions |
| SaaS plans | `SaaasPlan` (free/starter/business/enterprise) | ✅ Seeded |

### 1.3 What's Missing (The Gaps)

#### Gap 1: Reseller Economics (P0 — revenue)
- **No payout model.** `TenantBalance` tracks the balance but there's no payout/withdrawal flow. Resellers can't withdraw earnings.
- **No revenue share calculation.** The ledger records customer payment + platform fee, but there's no explicit "reseller earnings" entry that shows what the reseller netted.
- **No provider cost tracking.** For supplier offers (eSIM, telco), the wholesale cost is recorded but not automatically deducted from the reseller's balance.
- **No reconciliation cron.** No periodic job that reconciles ledger entries with actual provider costs.

#### Gap 2: Marketplace Flow Completion (P0 — revenue)
- **No intent → purchase flow.** The ranking engine returns offers, but there's no flow from a ranked offer to checkout. The customer must already have a product ID.
- **No "buy from ranked offer" API.** A ranked offer has `resellerProductId` (nullable) but no API creates a product from an offer and links them.
- **No storefront page.** No customer-facing page where a customer expresses intent and sees ranked offers.

#### Gap 3: Connectivity Intelligence (P1 — differentiation)
- **No intent parser.** The `ConnectivityIntent` model stores structured fields (capabilityType, desiredSpec, location), but there's no parser that converts natural language ("I need internet in Accra today") into structured intent.
- **No intent → ranked offers → purchase UI.** The ranking API exists but there's no customer-facing page.

#### Gap 4: Operator Onboarding Completion (P1 — growth)
- **No role-specific onboarding.** The signup creates a tenant but doesn't guide the operator through connecting infrastructure, creating offers, and launching a storefront based on their type (WiFi/telco/eSIM).
- **No "connect provider feed" flow.** For telco/eSIM resellers, there's no UI to connect a supplier feed and import offers.

#### Gap 5: B2B Layer (P2 — expansion)
- **No employee connectivity management.** `Organization` + `OrganizationMember` exist but there's no flow to provision connectivity for employees.
- **No spending controls UI.** Spend limits exist on the model but there's no API or UI to manage them.
- **No B2B invoices.** No invoice generation for organizational purchases.
- **No usage analytics for organizations.**

#### Gap 6: Analytics (P1 — operations)
- **No reseller dashboard.** No revenue, profit, customer, or usage analytics for the reseller.
- **No RoamLink platform dashboard.** No GMV, contribution profit, provider exposure, active operators, or retention metrics.

---

## 2. Commercial Gap Analysis

### Revenue Blockers (must fix to collect money)

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| 1 | No payout flow | Resellers can't withdraw earnings → they won't sell | 3 days |
| 2 | No intent → purchase flow | Customers can't buy from ranked offers → marketplace is theoretical | 3 days |
| 3 | No provider cost deduction | Reseller balance doesn't reflect supplier costs → financial truth is wrong | 2 days |

### Growth Blockers (must fix to scale)

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| 4 | No role-specific onboarding | Operators get stuck after signup | 3 days |
| 5 | No analytics | Resellers can't see their business → they churn | 4 days |
| 6 | No connectivity intelligence | The differentiator (intent → ranked offers) isn't exposed | 3 days |

### Expansion Blockers (must fix for B2B)

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| 7 | No B2B employee provisioning | Can't sell to businesses | 5 days |
| 8 | No B2B spending controls | Can't enforce budgets | 2 days |
| 9 | No B2B invoices | Can't bill organizations | 3 days |

---

## 3. Database Changes

### 3.1 New Models (minimal additions)

#### `ResellerPayout` — reseller withdrawal of earnings
```prisma
model ResellerPayout {
  id              String   @id @default(cuid())
  tenantId        String
  amountMinor     Int      // amount being withdrawn
  currency        String   @default("USD")
  status          String   @default("pending") // pending | processing | completed | failed
  method          String   // bank_transfer | mobile_money | stripe_transfer
  destinationRef  String?  // reference to the payout destination (bank account, mobile money number)
  ledgerTransactionId String? // linked ledger entry
  processedAt     DateTime?
  failedAt        DateTime?
  failureReason   String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([status])
}
```

#### `ProviderCost` — tracks the wholesale cost of supplier offers
```prisma
model ProviderCost {
  id              String   @id @default(cuid())
  tenantId        String
  orderId         String   // linked CustomerOrder
  offerId         String?  // linked ConnectivityOffer2
  supplierId      String?
  wholesaleCostMinor Int   // what the reseller owes the supplier
  currency        String   @default("USD")
  status          String   @default("pending") // pending | settled | disputed
  settledAt       DateTime?
  ledgerTransactionId String? // linked ledger entry for the deduction
  createdAt       DateTime @default(now())

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([orderId])
  @@index([supplierId])
}
```

#### `ResellerEarning` — explicit earnings record per order
```prisma
model ResellerEarning {
  id              String   @id @default(cuid())
  tenantId        String
  orderId         String
  customerPaymentMinor Int  // what the customer paid
  wholesaleCostMinor Int   // what the reseller paid the supplier (0 for own infra)
  paymentFeeMinor Int      // payment processing fee
  platformFeeMinor Int     // RoamLink's platform fee
  resellerEarningMinor Int // customerPayment - wholesale - paymentFee - platformFee
  currency        String   @default("USD")
  createdAt       DateTime @default(now())

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([orderId]) // one earning per order
  @@index([tenantId])
}
```

#### `IntentRequest` — natural language intent (extends ConnectivityIntent)
```prisma
model IntentRequest {
  id              String   @id @default(cuid())
  tenantId        String
  customerId      String?
  rawText         String?  // "I need internet in Accra today"
  parsedIntent    String   // JSON: { capabilityType, desiredSpec, location, maxPriceMinor }
  rankedOfferIds  String?  // JSON: [offerId, ...]
  selectedOfferId String?  // the offer the customer chose (if any)
  status          String   @default("pending") // pending | ranked | selected | purchased | expired
  createdAt       DateTime @default(now())

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([status])
}
```

#### `EmployeeEntitlement` — B2B employee connectivity
```prisma
model EmployeeEntitlement {
  id              String   @id @default(cuid())
  organizationId  String
  memberId        String   // OrganizationMember
  entitlementId   String?  // linked ConnectivityEntitlement (when provisioned)
  productId       String?  // the product the org chose for this employee
  status          String   @default("pending") // pending | active | suspended | revoked
  createdAt       DateTime @default(now())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@index([memberId])
}
```

### 3.2 Back-relations on Tenant
- `payouts ResellerPayout[]`
- `providerCosts ProviderCost[]`
- `resellerEarnings ResellerEarning[]`
- `intentRequests IntentRequest[]`

### 3.3 Back-relation on Organization
- `employeeEntitlements EmployeeEntitlement[]`

---

## 4. Implementation Roadmap

### Phase 6.1 — Reseller Economics (Week 1)

**Goal:** Resellers can see earnings, have costs deducted, and request payouts.

| Step | What | Files |
|------|------|-------|
| 6.1.1 | Add `ResellerPayout`, `ProviderCost`, `ResellerEarning` models | `prisma/schema.prisma` |
| 6.1.2 | Create `src/lib/commerce/reseller-economics.ts` — `calculateEarnings()`, `deductProviderCost()`, `requestPayout()`, `processPayout()` | new file |
| 6.1.3 | Wire `fulfillOrder()` to create `ResellerEarning` + `ProviderCost` records | `src/lib/commerce/fulfillment.ts` |
| 6.1.4 | Add payout API: `POST /api/commerce/payouts` (reseller requests withdrawal) | new route |
| 6.1.5 | Add reconciliation: `POST /api/internal/reconcile-provider-costs` (settles pending ProviderCost records) | new route |
| 6.1.6 | Tests: earnings calculation, cost deduction, payout flow, idempotency | new test file |

### Phase 6.2 — Marketplace Completion (Week 1–2)

**Goal:** Customer intent → ranked offers → purchase → payment → fulfillment → ledger → earnings.

| Step | What | Files |
|------|------|-------|
| 6.2.1 | Add `POST /api/commerce/offers/[offerId]/publish` — creates a ResellerProduct from a ranked offer | new route |
| 6.2.2 | Add `POST /api/commerce/intent/[intentId]/purchase` — purchases the selected offer from a ranked intent | new route |
| 6.2.3 | Build the marketplace storefront page (`/marketplace`) — intent input → ranked offers → buy | new page |
| 6.2.4 | Wire the full flow: intent → rank → select offer → create order → payment intent → webhook → fulfill → ledger → earning | integration |
| 6.2.5 | Tests: end-to-end marketplace flow | new test file |

### Phase 6.3 — Connectivity Intelligence (Week 2)

**Goal:** Natural language intent → structured intent → ranked offers.

| Step | What | Files |
|------|------|-------|
| 6.3.1 | Add `IntentRequest` model | `prisma/schema.prisma` |
| 6.3.2 | Create `src/lib/commerce/intent-parser.ts` — deterministic parser (keyword + pattern matching, no AI) | new file |
| 6.3.3 | Add `POST /api/commerce/intent` — accepts raw text, parses, ranks, returns offers | new route |
| 6.3.4 | Build intent input UI on the marketplace page | marketplace page |
| 6.3.5 | Tests: intent parsing patterns (location, speed, budget, validity) | new test file |

### Phase 6.4 — Operator Onboarding Completion (Week 2)

**Goal:** Role-specific onboarding flows for WiFi/telco/eSIM operators.

| Step | What | Files |
|------|------|-------|
| 6.4.1 | Add onboarding step tracking to the tenant (metadata field) | no schema change |
| 6.4.2 | Build multi-step onboarding UI: choose type → connect infrastructure → create first offer → launch | new page |
| 6.4.3 | Add "connect supplier feed" flow for telco/eSIM (API key entry → test connection → import offers) | new route + UI |
| 6.4.4 | Tests: onboarding flow completion | new test file |

### Phase 6.5 — B2B Layer (Week 3)

**Goal:** Organizations can provision employee connectivity with spending controls.

| Step | What | Files |
|------|------|-------|
| 6.5.1 | Add `EmployeeEntitlement` model | `prisma/schema.prisma` |
| 6.5.2 | Create `src/lib/commerce/b2b.ts` — `provisionEmployeeConnectivity()`, `enforceSpendLimit()`, `generateInvoice()` | new file |
| 6.5.3 | Add B2B API: `POST /api/b2b/organizations/[orgId]/employees/[memberId]/provision` | new route |
| 6.5.4 | Add spending controls API: `PATCH /api/b2b/organizations/[orgId]/members/[memberId]/spend-limit` | new route |
| 6.5.5 | Add B2B invoice generation: `POST /api/b2b/organizations/[orgId]/invoices` | new route |
| 6.5.6 | Build B2B dashboard: employee list, spend tracking, invoices | new page |
| 6.5.7 | Tests: B2B provisioning, spend limit enforcement, invoice generation | new test file |

### Phase 6.6 — Analytics (Week 3)

**Goal:** Reseller + RoamLink dashboards.

| Step | What | Files |
|------|------|-------|
| 6.6.1 | Create `src/lib/analytics/reseller.ts` — `getResellerRevenue()`, `getResellerProfit()`, `getResellerCustomers()`, `getResellerUsage()` | new file |
| 6.6.2 | Create `src/lib/analytics/platform.ts` — `getGMV()`, `getContributionProfit()`, `getProviderExposure()`, `getActiveOperators()`, `getRetention()` | new file |
| 6.6.3 | Add reseller analytics API: `GET /api/analytics/reseller` | new route |
| 6.6.4 | Add platform analytics API: `GET /api/analytics/platform` (admin-only) | new route |
| 6.6.5 | Build reseller dashboard: revenue, profit, customers, usage charts | new page |
| 6.6.6 | Build RoamLink platform dashboard: GMV, profit, exposure, operators, retention | new page |
| 6.6.7 | Tests: analytics calculations | new test file |

---

## 5. Implementation Order

```
Week 1: Phase 6.1 (Reseller Economics) + Phase 6.2 (Marketplace Completion)
Week 2: Phase 6.3 (Connectivity Intelligence) + Phase 6.4 (Operator Onboarding)
Week 3: Phase 6.5 (B2B Layer) + Phase 6.6 (Analytics)
```

Each phase is independently shippable. Phase 6.1 + 6.2 together close the revenue loop. Phase 6.3 + 6.4 close the growth loop. Phase 6.5 + 6.6 close the expansion loop.

## 6. What's Preserved

- **Connectivity kernel** — FROZEN (no changes to entitlement.ts, provisioning, lease, convergence)
- **Provider adapter contract** — FROZEN (no changes to ConnectivityProviderAdapter)
- **Offer ranking engine** — FROZEN (no changes to rankOffers())
- **Double-entry ledger** — FROZEN (no changes to postLedgerTransaction() or the 9 ledger functions)
- **Commerce layer** — Extended (fulfillment.ts gets earning/cost records, but the core flow is unchanged)

## 7. Critical Rules Enforced

1. ✅ Every financial action goes through the ledger (existing `postLedgerTransaction` + new `ResellerEarning`/`ProviderCost` records link to it)
2. ✅ Every provider uses adapters (no direct provider calls — all through `ConnectivityProviderAdapter`)
3. ✅ Every offer is ranked through the intent engine (no bypass — the marketplace flow always calls `rankOffers()`)
4. ✅ No duplicate systems (reuse `TenantBalance`, `TenantTransaction`, `Organization`, `OrganizationMember`)
5. ✅ Extend existing models (back-relations on Tenant + Organization, no new billing kernel)
