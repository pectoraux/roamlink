# Phase 7 — Marketplace Reality: Audit & Implementation Plan

**Principal Architect**
**Baseline:** `b3193b5`
**Goal:** Production-commercially viable. Fastest path to $10k/month GMV.

---

## 1. Current Architecture Audit

### 1.1 Frozen Layers (verified intact at b3193b5)

| Layer | Lines | Status |
|-------|-------|--------|
| Connectivity kernel (entitlement.ts) | 2,114 | FROZEN |
| Offer ranking engine (ranking-engine.ts) | 433 | FROZEN |
| Double-entry ledger (double-entry-ledger.ts) | 551 | FROZEN |
| Commerce layer (fulfillment + reseller-economics) | ~600 | FROZEN |
| Provider adapter contract | — | FROZEN |

### 1.2 What Exists (Phase 3–6)

| Capability | Status |
|-----------|--------|
| Payment integration (Paystack/Stripe/Mock) | ✅ Wired (5.1) |
| Webhook processing (idempotent via WebhookEvent) | ✅ |
| Reseller onboarding (signup → tenant → trial) | ✅ |
| Provider instance management | ✅ |
| Checkout flow (payment intent → webhook → fulfill) | ✅ |
| Ledger integration (3 entries per order) | ✅ |
| ResellerEarning + ProviderCost + ResellerPayout | ✅ Models exist |
| getResellerBalance() | ✅ |
| Intent parser (deterministic, keyword-based) | ✅ |
| Intent API (parse → rank → IntentRequest) | ✅ |
| Marketplace page (intent → ranked offers → buy) | ✅ |
| Reseller analytics (revenue, profit, customers) | ✅ Basic |
| Platform analytics (GMV, fees, exposure) | ✅ Basic |
| ProviderInvoice model + recordProviderInvoice() | ✅ Existing |
| Provider credit accounts (commitments, settlements) | ✅ Existing |

### 1.3 What's Missing (Blockers to $10k/month GMV)

#### Blocker 1: No end-to-end business loop proof (P0)
The full loop (signup → inventory → intent → purchase → payment → fulfillment → costs → earnings → payout) has never been executed end-to-end in a single test. Each piece exists individually, but there's no integration test proving the entire flow works. If any link is broken, revenue is blocked.

#### Blocker 2: No supplier settlement flow (P0)
ProviderCost records are created but never linked to actual supplier invoices. The `ProviderInvoice` model + `recordProviderInvoice()` function exist but aren't wired to the commerce flow. Resellers can't see what they owe suppliers, and suppliers can't be paid.

#### Blocker 3: No reseller payout processing (P1)
`requestPayout()` + `processPayout()` exist, but there's no payout history view and no actual money movement (bank transfer, mobile money). Resellers can request a payout but nothing happens.

#### Blocker 4: No churn / retention metrics (P1)
The analytics dashboard shows revenue and profit but not churn, active users over time, or best-selling offers. Operators can't answer "am I retaining customers?"

#### Blocker 5: No AI intent extraction (P1)
The deterministic keyword parser handles simple cases but misses nuanced requests ("I need connectivity for a conference next week in Kumasi"). An LLM extraction layer would improve intent matching without changing the deterministic ranking.

#### Blocker 6: No trust signals (P1)
The ranking engine uses `reliabilityScore` (default 0.5) but it's never updated from actual provisioning outcomes. There are no customer ratings, uptime measurements, or speed tests. Customers can't trust the offers.

#### Blocker 7: No Ghana-specific optimization (P2)
The onboarding is generic. Ghanaian operators need: GHS currency, Paystack (not Stripe), mobile money payouts, local city coverage.

---

## 2. Remaining Blockers to $10k/month GMV

$10k/month GMV = ~200 orders/month at $50 average order value, or ~500 orders at $20.

| Blocker | Impact on GMV | Effort |
|---------|--------------|--------|
| End-to-end loop proof | CRITICAL — if broken, $0 | 2 days |
| Supplier settlement | HIGH — resellers won't sell if they can't pay suppliers | 3 days |
| Payout processing | HIGH — resellers won't sell if they can't withdraw | 2 days |
| Churn metrics | MEDIUM — operators need to see retention | 1 day |
| AI intent extraction | MEDIUM — improves conversion | 2 days |
| Trust signals | MEDIUM — customers need confidence | 2 days |
| Ghana optimization | LOW — the system works, just needs GHS + local context | 1 day |

**Total: ~13 days to close all blockers.**

The critical path is: **end-to-end loop proof → supplier settlement → payout processing**. These 3 close the revenue loop. The rest improve conversion and trust.

---

## 3. Database Changes

### 3.1 New Models

#### `SupplierSettlement` — aggregates provider costs into a settlement period
```prisma
model SupplierSettlement {
  id              String   @id @default(cuid())
  tenantId        String
  supplierId      String
  periodStart     DateTime
  periodEnd       DateTime
  totalCostMinor  Int      // sum of ProviderCost.wholesaleCostMinor
  currency        String   @default("USD")
  status          String   @default("pending") // pending | invoiced | paid | disputed
  providerInvoiceId String? // linked ProviderInvoice
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, supplierId])
  @@index([status])
}
```

#### `OfferRating` — customer ratings for trust signals
```prisma
model OfferRating {
  id              String   @id @default(cuid())
  offerId         String
  tenantId        String
  customerId      String
  orderId         String
  rating          Int      // 1-5 stars
  review          String?
  createdAt       DateTime @default(now())

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([orderId]) // one rating per order
  @@index([offerId])
}
```

#### `UptimeMeasurement` — provider uptime tracking
```prisma
model UptimeMeasurement {
  id              String   @id @default(cuid())
  tenantId        String
  providerInstanceId String
  measuredAt      DateTime @default(now())
  isReachable     Boolean
  responseTimeMs  Int?
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, providerInstanceId])
  @@index([measuredAt])
}
```

### 3.2 Back-relations on Tenant
- `supplierSettlements SupplierSettlement[]`
- `offerRatings OfferRating[]`
- `uptimeMeasurements UptimeMeasurement[]`

---

## 4. Implementation Plan

### Phase 7.1 — End-to-End Business Loop Proof (2 days)

**Goal:** A single integration test proves the entire flow works.

| Step | What |
|------|------|
| 7.1.1 | Write `tests/phase7-business-loop.test.ts` that executes: signup → create product → create offer → customer intent → purchase → payment (mock) → webhook → fulfillment → ledger → earnings → provider cost → payout |
| 7.1.2 | Fix any broken links discovered during the integration test |
| 7.1.3 | The test must verify: order fulfilled, entitlement active, binding BOUND, ledger entries posted, earning recorded, provider cost recorded, payout requestable |

### Phase 7.2 — Settlement (3 days)

**Goal:** Suppliers can be invoiced and paid; resellers see full settlement.

| Step | What |
|------|------|
| 7.2.1 | Add `SupplierSettlement` model |
| 7.2.2 | Create `src/lib/commerce/settlement.ts` — `createSupplierSettlement()`, `generateSupplierInvoice()`, `settleSupplierInvoice()` |
| 7.2.3 | Wire `settlePendingProviderCosts()` to group costs by supplier + period → create settlements |
| 7.2.4 | Add APIs: `GET /api/commerce/settlements` (list), `POST /api/commerce/settlements/[id]/invoice` (generate invoice) |
| 7.2.5 | Add payout history API: `GET /api/commerce/payouts` (already exists, enhance with filters) |

### Phase 7.3 — Operator Success Metrics (1 day)

**Goal:** Operators see churn, active users, best-selling offers.

| Step | What |
|------|------|
| 7.3.1 | Extend `getResellerAnalytics()` with: churn rate, active users trend, best-selling offers (top 5 by revenue) |
| 7.3.2 | Update the analytics dashboard UI with new metrics |

### Phase 7.4 — AI Intent Extraction (2 days)

**Goal:** LLM extracts structured intent from natural language; ranking stays deterministic.

| Step | What |
|------|------|
| 7.4.1 | Create `src/lib/commerce/ai-intent.ts` — uses z-ai-web-dev-sdk LLM to extract structured intent from raw text |
| 7.4.2 | The LLM produces ONLY structured output (ParsedIntent JSON) — it does NOT rank offers |
| 7.4.3 | Update `POST /api/commerce/intent` to try AI extraction first, fall back to deterministic parser |
| 7.4.4 | The deterministic `rankOffers()` is UNCHANGED — it receives the structured intent and scores deterministically |

### Phase 7.5 — Ghana Pilot Workflow (1 day)

**Goal:** Onboarding optimized for Ghanaian operators.

| Step | What |
|------|------|
| 7.5.1 | Add GHS currency support to checkout + products |
| 7.5.2 | Add Ghana-specific cities to the intent parser (Accra, Kumasi, Takoradi, Tamale, Tema, Cape Coast) |
| 7.5.3 | Add mobile money as a payout method (already in the model, just needs UI) |
| 7.5.4 | Add Paystack as the default payment provider for Ghanaian tenants |

### Phase 7.6 — Marketplace Trust Signals (2 days)

**Goal:** Customers see reliability, ratings, uptime.

| Step | What |
|------|------|
| 7.6.1 | Add `OfferRating` + `UptimeMeasurement` models |
| 7.6.2 | Create `POST /api/commerce/orders/[id]/rate` — customer rates an order |
| 7.6.3 | Create `POST /api/internal/measure-uptime` — cron that pings provider instances |
| 7.6.4 | Update the ranking engine's reliability score from actual provisioning outcomes (success/failure counts) |
| 7.6.5 | Display ratings + uptime on the marketplace page |

---

## 5. Priority Order

```
Week 1: 7.1 (loop proof) → 7.2 (settlement) → 7.3 (metrics)
Week 2: 7.4 (AI intent) → 7.5 (Ghana) → 7.6 (trust signals)
```

The fastest path to revenue is 7.1 + 7.2 + 7.3. These prove the loop works, close the settlement gap, and give operators the metrics they need. The rest improves conversion and trust.

## 6. What's Preserved

- Connectivity kernel — FROZEN
- Provider adapter contract — FROZEN
- Offer ranking engine — FROZEN (AI only extracts intent; ranking stays deterministic)
- Commerce layer — Extended (settlement + trust signals added)
- Double-entry ledger — FROZEN
- Reseller economics — Extended (settlement wires into existing ProviderCost)
