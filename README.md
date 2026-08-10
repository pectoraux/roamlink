# RoamLink — eSIM Reseller Marketplace (MVP)

RoamLink is a **Level 1 eSIM reseller marketplace**: a storefront that lets
travelers browse, buy, install, and top up travel eSIM data plans. It is built
as a provider-independent platform — the storefront never talks to a specific
eSIM or payment provider directly. Everything goes through adapter interfaces,
so swapping in a real telecom provider (Airalo, Soracom, eSIMX, …) or a real
payment provider (Stripe, Paystack, …) only requires implementing one adapter
per side.

This repository is the **MVP**: a fully-functional end-to-end flow backed by a
mock eSIM provider and a mock payment provider that exercise the exact same
server-side code paths a real integration would. The mock provider generates
clearly-marked **development** values (fake ICCIDs, fake SM-DP+ addresses, fake
activation codes) so you can demo the entire purchase → install → usage → top-up
journey locally.

> ⚠️ **No real telecom or payment credentials are shipped.** Real provider
> integrations are *documented boundaries* — see
> [`docs/esim-provider.md`](docs/esim-provider.md) and
> [`docs/payments.md`](docs/payments.md). Never fabricate a provider API;
> implement only against the provider's real, documented HTTP API.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Quick Start](#quick-start)
3. [Environment Variables](#environment-variables)
4. [Database](#database)
5. [Running the App](#running-the-app)
6. [Architecture Summary](#architecture-summary)
7. [Mock eSIM Provider](#mock-esim-provider)
8. [Replacing the Mock eSIM Provider](#replacing-the-mock-esim-provider)
9. [Payment Providers](#payment-providers)
10. [Webhooks](#webhooks)
11. [Business Rules](#business-rules)
12. [Key Routes](#key-routes)
13. [Definition of Done](#definition-of-done)
14. [Production Build](#production-build)
15. [Further Documentation](#further-documentation)

---

## Tech Stack

| Layer            | Technology                                                          |
| ---------------- | ------------------------------------------------------------------- |
| Framework        | [Next.js 16](https://nextjs.org) (App Router, React 19, Server Components) |
| Language         | [TypeScript](https://www.typescriptlang.org) 5                      |
| Styling          | [Tailwind CSS 4](https://tailwindcss.com)                           |
| UI primitives    | [shadcn/ui](https://ui.shadcn.com) + [Radix UI](https://www.radix-ui.com) |
| ORM              | [Prisma](https://www.prisma.io) 6                                   |
| Database         | PostgreSQL ([Neon](https://neon.tech)) — dev, staging, and prod      |
| Runtime / pkg mgr| [Bun](https://bun.sh)                                               |
| Forms/validation | [React Hook Form](https://react-hook-form.com) + [Zod](https://zod.dev) |
| QR codes         | [`qrcode`](https://www.npmjs.com/package/qrcode)                    |
| Auth             | Provider-independent session-based auth (bcrypt + opaque DB sessions) |
| Data fetching    | [TanStack Query](https://tanstack.com/query) 5                      |

Money is stored and processed everywhere as **integer minor units** (cents).
Floating-point is never used for monetary values. See
[`src/lib/money.ts`](src/lib/money.ts) and
[`docs/architecture.md`](docs/architecture.md#money-handling).

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set AUTH_SECRET (see below)

# 3. Push the Prisma schema to PostgreSQL (Neon)
bun run db:push

# 4. Seed demo data (pricing rules + 24 plans across 11 countries + admin + demo users)
bun run db:seed

# 5. Run the dev server
bun run dev
# → http://localhost:3000
```

### Demo accounts (seeded)

| Role     | Email                  | Password    | Notes                                  |
| -------- | ---------------------- | ----------- | -------------------------------------- |
| Admin    | `admin@esim.local`     | `admin12345`| Full admin panel access                |
| Customer | `demo@esim.local`      | `demo12345` | Customer storefront + dashboard access |

> You can override the admin email/password via `ADMIN_EMAIL` / `ADMIN_PASSWORD`
> env vars before running `bun run db:seed`.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in. **Never commit `.env`.**

```ini
# --- Database ---------------------------------------------------------------
# Neon pooled connection (for the app runtime):
DATABASE_URL="postgresql://USER:PASS@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require"
# Neon direct connection (for Prisma migrations):
DIRECT_URL="postgresql://USER:PASS@HOST.REGION.aws.neon.tech/DB?sslmode=require"
# Production: PostgreSQL
# DATABASE_URL="postgresql://user:pass@localhost:5432/esim?schema=public"

# --- eSIM Provider ----------------------------------------------------------
# mock | (real provider key when implemented, e.g. "airalo")
ESIM_PROVIDER=mock
ESIM_API_URL=
ESIM_API_KEY=
ESIM_API_SECRET=

# --- Payment Provider -------------------------------------------------------
# mock | (real provider key when implemented, e.g. "stripe")
PAYMENT_PROVIDER=mock
PAYMENT_API_URL=
PAYMENT_API_KEY=
PAYMENT_API_SECRET=

# --- Webhook signing (shared secrets used to verify inbound webhooks) -------
ESIM_WEBHOOK_SECRET=
PAYMENT_WEBHOOK_SECRET=

# --- App URLs ---------------------------------------------------------------
APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# --- Auth -------------------------------------------------------------------
# Generate with: openssl rand -base64 32
AUTH_SECRET=change-me-to-a-long-random-string

# --- Admin bootstrap (used by seed script) ----------------------------------
ADMIN_EMAIL=admin@esim.local
ADMIN_PASSWORD=admin12345
```

### Required for first run

- `DATABASE_URL` — PostgreSQL connection string (Neon pooled).
- `DIRECT_URL` — PostgreSQL connection string (Neon direct, for migrations).
- `AUTH_SECRET` — **must** be set to a long random string. Generate with
  `openssl rand -base64 32`. This is used to sign session cookies and tokens.

### Required to switch to a real eSIM provider

- `ESIM_PROVIDER` set to a non-`mock` key (e.g. `airalo`)
- `ESIM_API_URL`, `ESIM_API_KEY`, `ESIM_API_SECRET` from the provider
- `ESIM_WEBHOOK_SECRET` — the shared secret used to verify inbound webhooks
  from the provider (set this **on both sides**)

See [`docs/esim-provider.md`](docs/esim-provider.md) for the full integration
guide.

### Required to switch to a real payment provider

- `PAYMENT_PROVIDER` set to a non-`mock` key (e.g. `stripe` or `paystack`)
- `PAYMENT_API_KEY` / `PAYMENT_API_SECRET` from the provider
- `PAYMENT_WEBHOOK_SECRET` — shared secret for inbound payment webhooks

See [`docs/payments.md`](docs/payments.md).

---

## Database

### PostgreSQL (Neon) — the canonical database

RoamLink uses PostgreSQL (Neon) as the canonical database for **all**
environments — development, staging, and production. SQLite is **not** supported.

The Prisma schema is already configured for PostgreSQL:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

Set your Neon connection strings in `.env`:

```ini
# Neon pooled connection (for the app runtime)
DATABASE_URL="postgresql://USER:PASS@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require"
# Neon direct connection (for Prisma migrations)
DIRECT_URL="postgresql://USER:PASS@HOST.REGION.aws.neon.tech/DB?sslmode=require"
```

Then push the schema and seed:

```bash
bun run db:push     # push schema to PostgreSQL (idempotent)
bun run db:seed     # seed plans + admin + demo accounts
```

> All money fields are `Int` (minor units). All status enums are stored as
> plain strings (no native enums) for maximum portability, but PostgreSQL is
> the only supported database.

See [`docs/database.md`](docs/database.md) for the full schema reference.

---

## Running the App

```bash
# Development (port 3000, logs to dev.log)
bun run dev

# Production build
bun run build

# Production start (Bun standalone server)
bun run start
```

The dev server runs at **http://localhost:3000**.

---

## Architecture Summary

```mermaid
flowchart LR
  Browser[Browser<br/>React 19 + Tailwind + shadcn/ui] -->|HTTP| Next[Next.js 16<br/>App Router]
  Next -->|Server Components / API routes| Lib[Service layer<br/>src/lib/*]
  Lib --> ESim[ESIMProvider<br/>interface]
  Lib --> Pay[PaymentProvider<br/>interface]
  ESim -->|mock| MockE[MockESIMProvider<br/>in-memory dev values]
  ESim -->|real| RealE[RealESIMProvider<br/>adapter — implement against real API]
  Pay -->|mock| MockP[MockPaymentProvider]
  Pay -->|real| RealP[Real payment adapter<br/>Stripe / Paystack / ...]
  Lib --> Prisma[Prisma Client]
  Prisma --> DB[(PostgreSQL<br/>Neon)]
  RealE -.webhook.-> WH1[POST /api/webhooks/esim]
  RealP -.webhook.-> WH2[POST /api/payments/webhook]
  WH1 --> Lib
  WH2 --> Lib
```

### The purchase flow — order state machine

Every order walks a strict state machine. Transitions are validated in
[`src/lib/orders/state-machine.ts`](src/lib/orders/state-machine.ts); illegal
transitions throw `409 Conflict`.

```mermaid
stateDiagram-v2
  [*] --> PLAN_SELECTED
  PLAN_SELECTED --> CHECKOUT_CREATED
  CHECKOUT_CREATED --> PAYMENT_PENDING
  PAYMENT_PENDING --> PAYMENT_CONFIRMED: server-side verify success
  PAYMENT_PENDING --> PAYMENT_FAILED: verify failed
  PAYMENT_CONFIRMED --> ESIM_PROVISIONING
  ESIM_PROVISIONING --> ESIM_PROVISIONED
  ESIM_PROVISIONED --> COMPLETED
  PAYMENT_FAILED --> PAYMENT_PENDING: retry
  PAYMENT_CONFIRMED --> PROVISIONING_FAILED: provider error
  ESIM_PROVISIONING --> PROVISIONING_FAILED: provider error
  PROVISIONING_FAILED --> ESIM_PROVISIONING: retry
  COMPLETED --> REFUNDED
  PLAN_SELECTED --> CANCELLED
  CHECKOUT_CREATED --> CANCELLED
  PAYMENT_PENDING --> CANCELLED
  PAYMENT_CONFIRMED --> REFUNDED
  ESIM_PROVISIONING --> REFUNDED
  ESIM_PROVISIONED --> REFUNDED
  PROVISIONING_FAILED --> REFUNDED
  PROVISIONING_FAILED --> CANCELLED
```

Happy path:

```
PLAN_SELECTED → CHECKOUT_CREATED → PAYMENT_PENDING → PAYMENT_CONFIRMED
              → ESIM_PROVISIONING → ESIM_PROVISIONED → COMPLETED
```

### Idempotency

A network retry must NEVER cause:

- one payment → two eSIMs,
- one payment → two provider orders,
- a duplicated webhook application,
- a duplicated top-up charge.

Idempotency is enforced at **three layers**:

1. **Database unique constraints** — `Order.idempotencyKey`, `Payment.idempotencyKey`,
   `TopUp.idempotencyKey`, `ESIM.orderId` (1:1), `WebhookEvent.(provider, externalId)`.
2. **Provider-level idempotency keys** — every state-changing call to the
   eSIM or payment provider carries an idempotency key, so the provider returns
   the same result on retry instead of duplicating the side effect.
3. **Webhook dedup** — inbound webhooks are recorded in `WebhookEvent` keyed by
   `(provider, externalId)`. Replays are detected and short-circuited.

### Server-side payment verification

The frontend **never** has the authority to mark a payment as succeeded. The
flow is:

1. `POST /api/payments` → server calls `paymentProvider.createPaymentIntent()`
   → returns a `providerReference` (+ optional `clientSecret` for SDK-based flows).
2. Client confirms the payment via the provider's hosted UI / SDK.
3. `POST /api/payments/confirm` → server calls
   `paymentProvider.verifyPayment()` against the provider's API. Only if the
   provider says "succeeded" does the order advance to `PAYMENT_CONFIRMED`
   and provisioning begin.
4. A webhook (`POST /api/payments/webhook`) reconciles any out-of-band updates.

For the mock provider, step 2 is replaced by a synchronous call to
`mockPaymentProvider.confirmIntent()` so the whole flow can run end-to-end
without a real provider SDK.

See [`docs/architecture.md`](docs/architecture.md) for the full diagrams.

---

## Mock eSIM Provider

`MockESIMProvider` (`src/lib/esim/mock-provider.ts`) is a **fully-functional,
in-memory** eSIM provider used for development and testing. It simulates the
entire lifecycle of a real provider without any external network calls.

### What it simulates

| Operation            | Mock behaviour                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `getPlans()`         | Returns a fixed catalog of 24 plans across 11 countries (Ghana, Togo, Nigeria, Benin, Côte d'Ivoire, Senegal, Kenya, South Africa, France, UK, US). |
| `createOrder()`      | Returns a `mock-order-…` id. Idempotent per idempotency key.                                |
| `provisionESIM()`    | Generates a **fake 20-digit ICCID** (`890100…`), a fake SM-DP+ address (`smdp.mock.esim-dev.test`), and a clearly-marked fake activation code (`DEV-$ACTIVATION-…`). Idempotent per idempotency key. |
| `getUsage()`         | Returns the current remaining MB from the in-memory record.                                 |
| `topUp()`            | Adds MB to the in-memory eSIM record. Idempotent per idempotency key.                       |
| `cancel()`           | Marks the in-memory eSIM as `cancelled`.                                                    |
| `verifyWebhook()`    | HMAC-SHA256 verification against `ESIM_WEBHOOK_SECRET`.                                     |
| `simulateUsage()`    | Dev-only helper: deducts N MB from an eSIM and records a `simulated` usage sample. Used by the "Simulate usage" button in the dashboard. |

> **All values produced by the mock provider are clearly-marked development
> values.** ICCIDs start with `890100`, the SM-DP+ address is
> `smdp.mock.esim-dev.test`, and activation codes start with `DEV-$ACTIVATION-`.
> They will not activate on any real device. The architecture allows a real
> provider's SM-DP+ and activation info to be inserted in their place without
> changing the UI.

### State held in memory

The mock provider holds plans, orders, eSIMs, and idempotency-key maps in
per-process memory. Restarting the dev server **resets this state** (but the
DB rows — `ESIM`, `Usage`, `TopUp` — persist). For a fully repeatable demo,
re-seed after restart:

```bash
bun run db:push && bun run db:seed
```

---

## Replacing the Mock eSIM Provider

The application **never** imports a concrete eSIM provider directly. It goes
through the `ESIMProvider` interface
([`src/lib/esim/provider.ts`](src/lib/esim/provider.ts)). The factory
[`src/lib/esim/index.ts`](src/lib/esim/index.ts) selects the concrete provider
based on `ESIM_PROVIDER`:

| `ESIM_PROVIDER` value | Selected adapter                                |
| --------------------- | ----------------------------------------------- |
| `mock` (default)      | `MockESIMProvider`                              |
| any other value       | `RealESIMProvider` (a structural boundary)      |

### Steps to wire in a real provider (Airalo / Soracom / eSIMX / …)

1. **Read the provider's real API documentation.** Do NOT fabricate calls —
   implement only what the provider documents.
2. Implement each method of `RealESIMProvider`
   ([`src/lib/esim/real-provider.ts`](src/lib/esim/real-provider.ts)) against
   the provider's HTTP API. Typical mapping:

   | Interface method          | Typical HTTP call                                    |
   | ------------------------- | ---------------------------------------------------- |
   | `getPlans()`              | `GET {ESIM_API_URL}/plans`                           |
   | `getPlan(id)`             | `GET {ESIM_API_URL}/plans/{id}`                      |
   | `createOrder()`           | `POST {ESIM_API_URL}/orders` with `Idempotency-Key` header |
   | `provisionESIM()`         | `POST {ESIM_API_URL}/orders/{id}/esim` or `GET /orders/{id}` |
   | `getESIM()`               | `GET {ESIM_API_URL}/esims/{id}`                      |
   | `getUsage()`              | `GET {ESIM_API_URL}/esims/{id}/usage`                |
   | `getTopUpPackages()`      | `GET {ESIM_API_URL}/esims/{id}/topups`               |
   | `topUp()`                 | `POST {ESIM_API_URL}/esims/{id}/topups`              |
   | `cancel()`                | `POST {ESIM_API_URL}/esims/{id}/cancel`              |
   | `verifyWebhook()`         | verify HMAC-SHA256 signature with `ESIM_WEBHOOK_SECRET` |

3. Each method must normalize the provider-native payload into the canonical
   types (`CanonicalPlan`, `ProvisioningResult`, `UsageSample`, `TopUpPackage`,
   `TopUpResult`, `ProviderWebhookEvent`). Provider-native shapes must never
   leak past the adapter.
4. Configure env vars:

   ```ini
   ESIM_PROVIDER=airalo             # or any non-mock key
   ESIM_API_URL=https://api.airalo.com/v2
   ESIM_API_KEY=...
   ESIM_API_SECRET=...
   ESIM_WEBHOOK_SECRET=...          # set on both sides
   ```

5. Sync plans from the new provider:

   ```bash
   # Admin UI: /admin → Plans → Sync from provider
   # or via API (admin only):
   curl -X POST http://localhost:3000/api/plans/sync \
     -H "Cookie: esim_session=<admin session>"
   ```

Full integration guide, method-by-method contract, and the plan sync pipeline
are in [`docs/esim-provider.md`](docs/esim-provider.md).

> **Rule: never fabricate provider integrations.** The shipped
> `RealESIMProvider` throws "not implemented" for every method. Implement each
> method **only** against the provider's real, documented API.

---

## Payment Providers

Payments are abstracted behind the `PaymentProvider` interface
([`src/lib/payments/provider.ts`](src/lib/payments/provider.ts)). The factory
[`src/lib/payments/index.ts`](src/lib/payments/index.ts) selects the concrete
provider based on `PAYMENT_PROVIDER`:

| `PAYMENT_PROVIDER` value | Selected adapter          |
| ------------------------ | ------------------------- |
| `mock` (default)         | `MockPaymentProvider`     |
| any other value          | throws "not implemented" — implement a concrete adapter |

### The critical rule

> **Never trust the client's claim that payment succeeded.** The server always
> verifies with the provider before provisioning.

The mock provider simulates the entire flow:

1. `createPaymentIntent()` — returns a `mock-pay-…` reference. Idempotent per
   idempotency key. Honors a `forceFail=true` metadata flag to simulate
   failures.
2. `confirmIntent(providerReference)` — dev-only helper called by
   `/api/payments/confirm` to mark the intent succeeded (simulates the
   provider's own confirmation event).
3. `verifyPayment()` — reads back the truth from the in-memory intent. Returns
   `succeeded | failed | pending`.
4. `verifyWebhook()` — HMAC-SHA256 verification against
   `PAYMENT_WEBHOOK_SECRET`.

### Adding a real provider (Stripe / Paystack)

1. Implement a concrete adapter class that implements `PaymentProvider`:
   - `createPaymentIntent()` — call the provider's `POST /payment_intents` (or
     equivalent), return the provider reference + `clientSecret` for SDK-based
     confirmation.
   - `verifyPayment()` — call the provider's `GET /payment_intents/{id}` (or
     equivalent) to read the authoritative status.
   - `verifyWebhook()` — verify the provider's signature scheme (Stripe uses
     `Stripe-Signature` header, Paystack uses `x-paystack-signature`).
2. Register the adapter in `src/lib/payments/index.ts`.
3. Set `PAYMENT_PROVIDER`, `PAYMENT_API_KEY`, `PAYMENT_API_SECRET`,
   `PAYMENT_WEBHOOK_SECRET`.

> **Rule 10 — never store card data.** Use the provider's SDK or hosted
> checkout. Card numbers, CVVs, etc. must never touch our servers.

Full payment integration guide: [`docs/payments.md`](docs/payments.md).

---

## Webhooks

Two webhook endpoints are exposed:

| Endpoint                          | Source                | Signing secret             |
| --------------------------------- | --------------------- | -------------------------- |
| `POST /api/webhooks/esim`         | eSIM provider         | `ESIM_WEBHOOK_SECRET`      |
| `POST /api/payments/webhook`      | Payment provider      | `PAYMENT_WEBHOOK_SECRET`   |

### Signature verification

Each webhook is verified via **HMAC-SHA256** of the raw request body with the
relevant shared secret. The signature is read from the `x-signature` (or
`x-webhook-signature`) header. Mismatched signatures return `401 Unauthorized`.

### Idempotency

Every webhook is recorded in the `WebhookEvent` table, keyed uniquely by
`(provider, externalId)`. A replayed webhook with the same external ID is
detected and short-circuited (returns `{ ok: true, deduplicated: true }`)
without re-applying side effects.

### Testing webhooks

The mock providers verify webhook signatures exactly as a real provider would.
You can test the verification path with `curl`:

```bash
# Compute the HMAC signature
BODY='{"id":"evt-1","type":"usage.update","esimId":"mock-esim-xxx","dataRemainingMB":5120}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$ESIM_WEBHOOK_SECRET" | sed 's/^.* //')

curl -X POST http://localhost:3000/api/webhooks/esim \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIG" \
  -d "$BODY"
```

See [`docs/webhooks.md`](docs/webhooks.md) for the full reference and more
examples.

---

## Business Rules

The application enforces a strict set of business rules. Violations are bugs.

1. **Server-side payment verification is the only trusted path to provisioning.**
   The frontend's claim of "payment succeeded" is never trusted. The order
   only advances from `PAYMENT_PENDING` to `PAYMENT_CONFIRMED` after
   `paymentProvider.verifyPayment()` returns `succeeded`.
2. **One eSIM per order.** `ESIM.orderId` is `@unique` (1:1). Re-provisioning
   an order returns the existing eSIM instead of creating a new one.
3. **Wholesale pricing is never exposed to customers.** Provider plans are
   normalized into `CanonicalPlan` (which carries `wholesalePriceMinor`), and
   only `PublicPlan` (which omits wholesale fields) is ever sent to the browser
   or stored in the order's `planSnapshot`.
4. **Idempotency at every state-changing boundary.** Orders, payments, top-ups,
   provider orders, provisioning, and webhook applications are all idempotent
   by key. A network retry never produces a duplicate side effect.
5. **Every financial operation is auditable.** Every order, payment,
   provisioning, and top-up event is recorded in `AuditLog` with the acting
   user, IP, and a structured `detail` payload.
6. **Provider data is isolated behind adapters.** Provider-native shapes never
   leak past the adapter boundary. The rest of the application only sees
   canonical types.
7. **Webhook idempotency.** Inbound webhooks are deduplicated by
   `(provider, externalId)`; replays are no-ops.
8. **Money is integer minor units.** No floating-point. All arithmetic goes
   through `src/lib/money.ts`.
9. **Plan retail prices are computed from wholesale + markup rules.** Retail
   prices are never hard-coded into provider integrations. The pricing engine
   (`src/lib/plans/pricing.ts`) applies rules by scope (global / region /
   country) and priority.
10. **Never store card data.** Use the payment provider's SDK or hosted
    checkout. Our servers never see raw card numbers or CVVs.

---

## Key Routes

### Storefront

| Route                          | Description                                          |
| ------------------------------ | ---------------------------------------------------- |
| `/`                            | Landing page (hero, featured plans, popular destinations) |
| `/esim`                        | Browse all plans (filter by country, region, data, validity, sort) |
| `/esim/[planId]`               | Plan details page (coverage, networks, speed, "Buy") |
| `/checkout/[planId]`           | Checkout: review plan, create order, mock payment    |
| `/order/[id]`                  | Order detail / status / success page after payment   |
| `/login`                       | Sign in                                               |
| `/register`                    | Sign up                                               |

### Customer dashboard

| Route                                | Description                                          |
| ------------------------------------ | ---------------------------------------------------- |
| `/dashboard`                         | Dashboard home                                       |
| `/dashboard/esims`                   | "My eSIMs" list                                      |
| `/dashboard/esims/[id]`              | eSIM details: QR code, activation info, usage chart, simulate-usage |
| `/dashboard/esims/[id]/top-up`       | Browse + purchase top-up packages for an eSIM        |
| `/dashboard/orders`                  | Order history                                        |

### Admin

| Route                  | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `/admin`               | Admin home + stats (orders, eSIMs, revenue, users)  |
| `/admin/orders`        | All orders (filterable)                              |
| `/admin/plans`         | All plans, sync from provider, toggle status, edit price |
| `/admin/esims`         | All eSIMs across users                               |
| `/admin/users`         | All users                                            |
| `/admin/providers`     | Provider status (which eSIM/payment provider is active, mock vs real) |

### API routes

| Route                                  | Method(s)       | Description                                  |
| -------------------------------------- | --------------- | -------------------------------------------- |
| `/api/auth/register`                   | `POST`          | Register customer                            |
| `/api/auth/login`                      | `POST`          | Login                                         |
| `/api/auth/logout`                     | `POST`          | Logout                                        |
| `/api/auth/me`                         | `GET`           | Current user                                  |
| `/api/plans`                           | `GET`           | List/filter public plans                      |
| `/api/plans/[id]`                      | `GET`           | Public plan detail                            |
| `/api/plans/sync`                      | `POST`          | Sync plans from provider (admin)              |
| `/api/orders`                          | `GET`, `POST`   | List / create order                           |
| `/api/orders/[id]`                     | `GET`           | Order detail                                  |
| `/api/payments`                        | `POST`          | Initiate payment intent                       |
| `/api/payments/confirm`                | `POST`          | Server-side verify + provision                |
| `/api/payments/webhook`                | `POST`          | Inbound payment webhook                       |
| `/api/esims`                           | `GET`           | List user's eSIMs                             |
| `/api/esims/[id]`                      | `GET`           | eSIM detail                                   |
| `/api/esims/[id]/usage`                | `GET`, `POST`   | Usage history / simulate usage (dev)          |
| `/api/esims/[id]/topups`               | `GET`, `POST`   | List top-up packages / purchase top-up        |
| `/api/webhooks/esim`                   | `POST`          | Inbound eSIM provider webhook                 |
| `/api/admin/stats`                     | `GET`           | Admin stats                                   |
| `/api/admin/orders`                    | `GET`           | Admin: all orders                             |
| `/api/admin/plans`                     | `GET`           | Admin: all plans                              |
| `/api/admin/plans/[id]`                | `PATCH`         | Admin: update plan status / price             |
| `/api/admin/esims`                     | `GET`           | Admin: all eSIMs                              |
| `/api/admin/users`                     | `GET`           | Admin: all users                              |
| `/api/admin/providers`                 | `GET`           | Admin: provider status                        |

---

## Definition of Done

The MVP is considered "done" when this end-to-end flow passes manually:

1. **Browse** — Visit `/`, then `/esim`. Filter to **Ghana** plans. The
   `Ghana 10 GB / 30 Days` plan appears in the list.
2. **Select** — Click the plan → land on `/esim/<planId>` showing coverage
   (MTN, Vodafone, AirtelTigo), 4G/5G speed, 30-day validity, price
   (computed via the Africa 35% pricing rule from the wholesale cost).
3. **Checkout** — Click "Buy" → land on `/checkout/<planId>`. Sign in (or
   create an account). The page creates an order (`CHECKOUT_CREATED`) and a
   mock payment intent (`PAYMENT_PENDING`).
4. **Pay** — Click "Pay" → the client calls `/api/payments/confirm`. The
   server calls `mockPaymentProvider.confirmIntent()` (simulating the provider
   confirming) then `verifyPayment()` (server-side truth read-back).
5. **Verify** — Order transitions `PAYMENT_PENDING → PAYMENT_CONFIRMED`. A
   `Payment` row is marked `succeeded`. An audit log entry is written.
6. **Provision** — The server calls `mockESIMProvider.createOrder()` then
   `provisionESIM()`, generating a fake ICCID, SM-DP+ address, and activation
   code. A `QRCode.toDataURL("LPA:1<smdp>&<activationCode>")` is generated and
   stored. Order transitions `PAYMENT_CONFIRMED → ESIM_PROVISIONING →
   ESIM_PROVISIONED → COMPLETED`.
7. **Success page** — Browser redirects to `/order/<id>` showing order status
   `COMPLETED` and a link to the eSIM.
8. **My eSIMs** — Visit `/dashboard/esims`. The newly provisioned eSIM appears.
9. **eSIM details** — Click → `/dashboard/esims/<id>`. QR code is displayed.
   Activation instructions ("Scan this QR with your phone's camera") are
   shown. ICCID, SM-DP+ address, activation code, and match ID are visible and
   copyable.
10. **Usage display** — A usage chart shows current `dataRemaining` vs
    `dataAmount` (initially full). An initial `Usage` sample (0 used) was
    recorded at provisioning.
11. **Simulate usage** — Click "Simulate 500 MB" → `/api/esims/<id>/usage`
    `POST` deducts 500 MB. The chart updates. Remaining decreases.
12. **Remaining changes** — Repeating the simulate step continues to decrement
    remaining data. At 0 MB remaining, the eSIM status flips to `exhausted`.

A second pass with the **admin** account (`admin@esim.local` / `admin12345`)
should show:

- `/admin` displays the order, the eSIM, and the revenue.
- `/admin/plans` allows toggling a plan's status (active/inactive).
- `/admin/providers` shows the active eSIM + payment provider (mock).

---

## Production Build

```bash
# 1. Switch DB provider to postgresql in prisma/schema.prisma
# 2. Set DATABASE_URL to a real PostgreSQL connection string in .env
# 3. Generate the Prisma client and migrate
bun run db:generate
bun run db:migrate

# 4. Set production env vars (ESIM_PROVIDER, PAYMENT_PROVIDER, secrets, AUTH_SECRET)
# 5. Build
bun run build

# 6. Run the standalone server
bun run start
```

The build produces a standalone Next.js server in `.next/standalone/`. The
`build` script copies `.next/static` and `public/` into the standalone
directory so the resulting bundle is self-contained.

### Production hardening checklist

- [ ] `AUTH_SECRET` regenerated to a long random string.
- [ ] `ESIM_PROVIDER` / `PAYMENT_PROVIDER` switched off `mock`.
- [ ] `ESIM_WEBHOOK_SECRET` / `PAYMENT_WEBHOOK_SECRET` set on both sides.
- [ ] `DATABASE_URL` points to PostgreSQL.
- [ ] `prisma/schema.prisma` `provider = "postgresql"`.
- [ ] Cookies `secure: true` (automatic when `NODE_ENV=production`).
- [ ] Reverse proxy terminates TLS (Caddyfile included for reference).
- [ ] Background job runs `checkExpirations()` periodically to flip expired
      eSIMs to `expired` status.
- [ ] Webhook endpoints reachable from the public internet (provider must be
      able to deliver webhooks to `/api/webhooks/esim` and
      `/api/payments/webhook`).

---

## Further Documentation

| Document | Scope |
| -------- | ----- |
| [`docs/architecture.md`](docs/architecture.md) | Component diagram, provider abstraction boundaries, order state machine, idempotency, money handling, data model overview |
| [`docs/esim-provider.md`](docs/esim-provider.md) | `ESIMProvider` interface contract, mock implementation, real-provider integration guide, plan sync pipeline, `CanonicalPlan` vs `PublicPlan`, QR generation |
| [`docs/payments.md`](docs/payments.md) | `PaymentProvider` interface, server-side verification rule, mock flow, real-provider integration (Stripe / Paystack), webhook idempotency, no-card-data rule |
| [`docs/provisioning.md`](docs/provisioning.md) | Provisioning flow triggered after `PAYMENT_CONFIRMED`, `createOrder` → `provisionESIM` → store ICCID/SM-DP+/activation → QR → `COMPLETED`, one-eSIM-per-order, failure handling |
| [`docs/webhooks.md`](docs/webhooks.md) | Webhook endpoints, HMAC-SHA256 signature verification, `WebhookEvent` idempotency, event logging, mock-webhook testing with `curl` |
| [`docs/database.md`](docs/database.md) | PostgreSQL/Neon setup, every Prisma model documented, key constraints, money storage, indexes |

---

## License

This is an MVP / reference implementation. Replace the mock providers with
real integrations before any production use.
