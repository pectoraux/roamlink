# Database Schema

This document is the reference for the Prisma schema at
[`prisma/schema.prisma`](../prisma/schema.prisma). It covers the dev/prod
provider split, every model, key constraints, money storage, and indexes.

---

## Table of Contents

1. [Dev vs Production](#dev-vs-production)
2. [Money Storage](#money-storage)
3. [Models](#models)
4. [Key Constraints](#key-constraints)
5. [Indexes](#indexes)

---

## Dev vs Production

The schema is written to be **portable** between SQLite (dev) and PostgreSQL
(production). It avoids DB-specific features:

- **No native enums.** All "enum" fields are stored as plain strings with
  the legal values documented in code (e.g. `Order.status` is a string,
  the legal values are listed in `OrderStatus` in
  [`src/types/index.ts`](../src/types/index.ts)).
- **No arrays.** List-typed fields are stored as JSON strings (e.g.
  `Plan.networks` is a JSON-encoded `string[]`).
- **No JSON extension reliance.** JSON fields are stored as plain text and
  parsed in TS code with `JSON.parse`. (Prisma's native `Json` type works
  on both, but plain strings keep the schema portable to other ORMs and
  make raw SQL inspection easier.)

### Dev: SQLite

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

```ini
DATABASE_URL="file:./db/custom.db"
```

The SQLite file is created on demand by `bun run db:push`. Use SQLite for
local development and tests.

### Production: PostgreSQL

To switch:

1. Edit [`prisma/schema.prisma`](../prisma/schema.prisma):

   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```

2. Set a PostgreSQL connection string in `.env`:

   ```ini
   DATABASE_URL="postgresql://user:pass@localhost:5432/esim?schema=public"
   ```

3. Reset and migrate:

   ```bash
   bun run db:reset
   bun run db:migrate
   bun run db:seed
   ```

The Prisma client and all application code work identically on both
databases — that's the point of the portable schema.

### Migration commands

```bash
bun run db:push       # Push schema to DB (idempotent, accepts data loss)
bun run db:generate   # Regenerate the Prisma client
bun run db:migrate    # Create + apply a migration (dev)
bun run db:reset      # Drop and recreate (dev)
bun run db:seed       # Populate demo data
```

---

## Money Storage

> **All monetary values are stored as `Int` (minor units). Never
> floating-point.**

| Model          | Field              | Type  | Unit                          |
| -------------- | ------------------ | ----- | ----------------------------- |
| `Plan`         | `price`            | `Int` | Retail price in minor units   |
| `Plan`         | `wholesalePrice`   | `Int` | Wholesale cost in minor units |
| `Order`        | `amount`           | `Int` | Total charged                 |
| `Payment`      | `amount`           | `Int` | Payment amount                |
| `TopUp`        | `amount`           | `Int` | Top-up charge                 |
| `PricingRule`  | `value`            | `Int` | Fixed: minor units; Percentage: percent integer (30 = 30%) |

`Int` columns on SQLite are 64-bit integers; on PostgreSQL they're
`integer` (32-bit, ±2.1 billion). For a marketplace charging in minor
units of USD, 32-bit is fine (max ~$21M per row). If you expect larger
single values, change the column type to `BigInt` in the schema.

Data sizes (`Plan.dataAmount`, `ESIM.dataAmount`, `ESIM.dataRemaining`,
`Usage.dataUsed`, `Usage.dataRemaining`, `TopUp.dataAmount`) are stored as
`Int` in **megabytes**. 1 GB = 1024 MB. Max representable in 32-bit:
~2 TB — fine for travel eSIM data plans.

See [`src/lib/money.ts`](../src/lib/money.ts) for the money helpers
(`toMinorUnits`, `toMajorUnits`, `formatMoney`, etc.) and
[`architecture.md#money-handling`](architecture.md#money-handling) for the
design rationale.

---

## Models

### User

A customer or admin. Email + bcrypt password hash. The auth layer
([`src/lib/auth.ts`](../src/lib/auth.ts)) is the only place that reads
`passwordHash`.

| Field           | Type      | Notes                                              |
| --------------- | --------- | -------------------------------------------------- |
| `id`            | `String`  | `@id @default(cuid())`                             |
| `email`         | `String`  | `@unique` — case-sensitive lookup; auth lowercases |
| `name`          | `String?` | Optional display name                              |
| `passwordHash`  | `String`  | bcrypt hash                                        |
| `role`          | `String`  | `"customer"` (default) \| `"admin"`                |
| `emailVerified` | `DateTime?` | Set when user verifies email                     |
| `createdAt`     | `DateTime`| `@default(now())`                                  |
| `updatedAt`     | `DateTime`| `@updatedAt`                                       |

**Relations**: `sessions`, `orders`, `esims`, `payments`, `topUps`,
`auditLogs`, `passwordResetTokens`, `emailVerificationTokens`. All cascade
on user delete except `auditLogs` (SetNull on userId).

---

### Session

An opaque session token stored in the DB (not a JWT). Revocable, auditable.

| Field        | Type      | Notes                                                       |
| ------------ | --------- | ----------------------------------------------------------- |
| `id`         | `String`  | `@id @default(cuid())`                                      |
| `userId`     | `String`  | FK → `User.id`, cascade delete                              |
| `token`      | `String`  | `@unique` — 32-char random hex string                       |
| `expiresAt`  | `DateTime`| 30-day TTL from `auth.ts`                                   |
| `userAgent`  | `String?` | Captured at login                                           |
| `ip`         | `String?` | Captured at login                                           |
| `createdAt`  | `DateTime`| `@default(now())`                                           |

**Indexes**: `@@index([userId])`.

The cookie name is `esim_session` (see `SESSION_COOKIE` in
`src/lib/auth.ts`).

---

### PasswordResetToken

Single-use password reset tokens. 1-hour TTL.

| Field        | Type      | Notes                                  |
| ------------ | --------- | -------------------------------------- |
| `id`         | `String`  | `@id @default(cuid())`                 |
| `userId`     | `String`  | FK → `User.id`, cascade delete         |
| `token`      | `String`  | `@unique` — 32-char random hex         |
| `expiresAt`  | `DateTime`| 1 hour from creation                  |
| `usedAt`     | `DateTime?`| Set when the token is consumed        |
| `createdAt`  | `DateTime`| `@default(now())`                      |

**Indexes**: `@@index([userId])`.

Using a reset token also deletes all the user's sessions (forced logout).

---

### EmailVerificationToken

Single-use email verification tokens. 24-hour TTL.

| Field        | Type      | Notes                          |
| ------------ | --------- | ------------------------------ |
| `id`         | `String`  | `@id @default(cuid())`         |
| `userId`     | `String`  | FK → `User.id`, cascade delete |
| `token`      | `String`  | `@unique` — 32-char random hex |
| `expiresAt`  | `DateTime`| 24 hours from creation        |
| `createdAt`  | `DateTime`| `@default(now())`              |

**Indexes**: `@@index([userId])`.

---

### Plan

The canonical marketplace plan. Provider-native shapes are normalized into
this model at sync time. The DB `Plan` row is the source of truth for what
customers see on `/esim`.

| Field              | Type      | Notes                                                                |
| ------------------ | --------- | -------------------------------------------------------------------- |
| `id`               | `String`  | `@id @default(cuid())` — internal id, used in URLs and orders        |
| `providerId`       | `String`  | internal provider key (`"mock"`, `"airalo"`, etc.)                   |
| `providerPlanId`   | `String`  | provider's native plan id                                            |
| `name`             | `String`  | display name                                                         |
| `description`      | `String?` |                                                                      |
| `country`          | `String`  | e.g. `"Ghana"`                                                       |
| `countryCode`      | `String`  | ISO 3166-1 alpha-2, e.g. `"GH"`                                      |
| `region`           | `String`  | e.g. `"Africa"`, `"Europe"`, `"North America"`                       |
| `dataAmount`       | `Int`     | MB (1024 = 1 GB)                                                     |
| `dataUnit`         | `String`  | default `"MB"`                                                       |
| `validityDays`     | `Int`     |                                                                      |
| `price`            | `Int`     | retail price in minor units (computed by pricing engine)             |
| `wholesalePrice`   | `Int`     | wholesale cost in minor units (NEVER exposed to customers)           |
| `currency`         | `String`  | default `"USD"`                                                      |
| `coverage`         | `String?` | comma-separated countries / description                              |
| `networks`         | `String?` | JSON string: `["MTN","Vodafone"]`                                    |
| `roaming`          | `Boolean` | default `false`                                                      |
| `hotspot`          | `Boolean` | default `true`                                                       |
| `speed`            | `String?` | e.g. `"4G/5G"`                                                       |
| `topUpSupported`   | `Boolean` | default `true`                                                       |
| `status`           | `String`  | `"active"` (default) \| `"inactive"`                                 |
| `pricingRule`      | `String?` | JSON string: the rule that produced `price` (audit)                  |
| `metadata`         | `String?` | JSON string: raw provider-native payload (server-side only)          |
| `createdAt`        | `DateTime`| `@default(now())`                                                    |
| `updatedAt`        | `DateTime`| `@updatedAt`                                                         |

**Constraints**: `@@unique([providerId, providerPlanId])` — one row per
(provider, native plan id) pair. Plan sync upserts on this key.

**Indexes**: `@@index([countryCode])`, `@@index([region])`,
`@@index([status])`.

**Relations**: `orders` (one-to-many).

The `wholesalePrice` field is the heart of wholesale isolation: it's stored
server-side for the pricing engine and admin margin analysis, but
`toPublicPlan()` strips it before any plan reaches the browser.

---

### Order

The purchase flow state machine.

| Field               | Type      | Notes                                                                    |
| ------------------- | --------- | ------------------------------------------------------------------------ |
| `id`                | `String`  | `@id @default(cuid())`                                                   |
| `userId`            | `String`  | FK → `User.id`, cascade delete                                           |
| `planId`            | `String`  | FK → `Plan.id` (no cascade — plan deletion is disallowed)                |
| `status`            | `String`  | state machine (see below)                                                |
| `amount`            | `Int`     | total charged in minor units                                             |
| `currency`          | `String`  | default `"USD"`                                                          |
| `paymentStatus`     | `String`  | `"pending"` (default) \| `"succeeded"` \| `"failed"` \| `"refunded"`     |
| `paymentProvider`   | `String?` | e.g. `"mock"`, `"stripe"`                                                |
| `paymentReference`  | `String?` | provider's payment intent / charge id                                    |
| `providerOrderId`   | `String?` | eSIM provider's order id                                                 |
| `idempotencyKey`    | `String`  | `@unique` — idempotency for order creation                               |
| `planSnapshot`      | `String?` | JSON string: snapshot of plan at purchase (price, name, data, etc.)      |
| `failureReason`     | `String?` | set when status is `PAYMENT_FAILED` or `PROVISIONING_FAILED`             |
| `createdAt`         | `DateTime`| `@default(now())`                                                        |
| `updatedAt`         | `DateTime`| `@updatedAt`                                                             |

**Legal `status` values** (see `OrderStatus` in
[`src/types/index.ts`](../src/types/index.ts) and the state machine in
[`src/lib/orders/state-machine.ts`](../src/lib/orders/state-machine.ts)):

```
PLAN_SELECTED | CHECKOUT_CREATED | PAYMENT_PENDING | PAYMENT_CONFIRMED |
ESIM_PROVISIONING | ESIM_PROVISIONED | COMPLETED |
PAYMENT_FAILED | PROVISIONING_FAILED | CANCELLED | REFUNDED
```

**Constraints**: `idempotencyKey @unique` — guarantees one order per
idempotency key, preventing duplicate orders from network retries.

**Indexes**: `@@index([userId])`, `@@index([status])`,
`@@index([paymentStatus])`.

**Relations**: `user` (many-to-one), `plan` (many-to-one), `payments`
(one-to-many), `esim` (one-to-one, see `ESIM`).

The `planSnapshot` JSON is what makes historical orders accurate even if
the plan is later edited or deactivated — the order always shows the price,
name, data amount, and validity at purchase time.

---

### Payment

A payment attempt for an order. Retries create new payment rows; each
payment has a unique idempotency key.

| Field                | Type      | Notes                                                            |
| -------------------- | --------- | ---------------------------------------------------------------- |
| `id`                 | `String`  | `@id @default(cuid())`                                           |
| `userId`             | `String`  | FK → `User.id`, cascade delete                                   |
| `orderId`            | `String`  | FK → `Order.id`, cascade delete                                  |
| `amount`             | `Int`     | payment amount in minor units                                    |
| `currency`           | `String`  | default `"USD"`                                                  |
| `status`             | `String`  | `"pending"` (default) \| `"succeeded"` \| `"failed"` \| `"refunded"` |
| `provider`           | `String`  | e.g. `"mock"`, `"stripe"`                                        |
| `providerReference`  | `String?` | provider's payment intent / charge id                            |
| `idempotencyKey`     | `String?` | `@unique` — idempotency for payment intent creation              |
| `raw`                | `String?` | JSON string: provider response (server-side only)                |
| `createdAt`          | `DateTime`| `@default(now())`                                                |
| `updatedAt`          | `DateTime`| `@updatedAt`                                                     |

**Constraints**: `idempotencyKey @unique`.

**Indexes**: `@@index([orderId])`, `@@index([status])`.

**Relations**: `user` (many-to-one), `order` (many-to-one).

`raw` is server-side only — never serialized to the client. Useful for
debugging provider responses and for audit.

---

### ESIM

A provisioned eSIM. 1:1 with `Order` (enforced by `orderId @unique`).

| Field              | Type      | Notes                                                          |
| ------------------ | --------- | -------------------------------------------------------------- |
| `id`               | `String`  | `@id @default(cuid())`                                         |
| `userId`           | `String`  | FK → `User.id`, cascade delete                                 |
| `orderId`          | `String`  | `@unique` — one eSIM per order                                 |
| `provider`         | `String`  | eSIM provider key (`"mock"`, `"airalo"`, etc.)                 |
| `providerESIMId`   | `String?` | provider's native eSIM id                                      |
| `iccid`            | `String?` | 19-20 digit Integrated Circuit Card ID                         |
| `smdpAddress`      | `String?` | SM-DP+ server address                                          |
| `activationCode`   | `String?` | LPA activation code                                            |
| `matchId`          | `String?` | optional confirmation code                                     |
| `qrCode`           | `String?` | generated QR payload (data URL with LPA string encoded)        |
| `status`           | `String`  | `"pending"` (default) \| `"active"` \| `"expired"` \| `"suspended"` \| `"exhausted"` \| `"cancelled"` |
| `dataAmount`       | `Int`     | total allowance in MB                                          |
| `dataRemaining`    | `Int`     | remaining in MB                                                |
| `validityDays`     | `Int`     |                                                                |
| `expiresAt`        | `DateTime?`| computed at provisioning time: now + validityDays            |
| `createdAt`        | `DateTime`| `@default(now())`                                              |
| `updatedAt`        | `DateTime`| `@updatedAt`                                                   |

**Constraints**: `orderId @unique` — one eSIM per order (business rule 3).

**Indexes**: `@@index([userId])`, `@@index([status])`, `@@index([iccid])`.

**Relations**: `user` (many-to-one), `order` (one-to-one), `usages`
(one-to-many), `topUps` (one-to-many).

The `iccid` index supports admin lookups by ICCID. There's no unique
constraint on ICCID because the same ICCID could (in theory) be returned by
two different providers — but in practice it's unique per provider.

---

### Usage

A usage sample for an eSIM. Time-series data — each sync or webhook creates
a row.

| Field            | Type      | Notes                                                |
| ---------------- | --------- | ---------------------------------------------------- |
| `id`             | `String`  | `@id @default(cuid())`                               |
| `esimId`         | `String`  | FK → `ESIM.id`, cascade delete                       |
| `dataUsed`       | `Int`     | MB used in this sample (delta from previous)         |
| `dataRemaining`  | `Int`     | MB remaining at sample time                          |
| `source`         | `String`  | `"provider"` (default) \| `"simulated"`              |
| `timestamp`      | `DateTime`| `@default(now())`                                    |

**Indexes**: `@@index([esimId])`.

**Relations**: `esim` (many-to-one).

`source: "simulated"` rows are created by the dev-only "Simulate usage"
button on the eSIM details page. They never appear in production with a
real provider.

---

### TopUp

A top-up purchase for an eSIM.

| Field                | Type      | Notes                                            |
| -------------------- | --------- | ------------------------------------------------ |
| `id`                 | `String`  | `@id @default(cuid())`                           |
| `esimId`             | `String`  | FK → `ESIM.id`, cascade delete                   |
| `userId`             | `String`  | FK → `User.id`, cascade delete                   |
| `amount`             | `Int`     | charged in minor units                           |
| `currency`           | `String`  | default `"USD"`                                  |
| `dataAmount`         | `Int`     | MB added                                         |
| `paymentStatus`      | `String`  | `"pending"` (default) \| `"succeeded"` \| `"failed"` |
| `providerReference`  | `String?` | provider's top-up reference                      |
| `idempotencyKey`     | `String`  | `@unique` — idempotency for top-up purchase      |
| `createdAt`          | `DateTime`| `@default(now())`                                |

**Constraints**: `idempotencyKey @unique` — prevents duplicate top-up
charges on retry.

**Indexes**: `@@index([esimId])`.

**Relations**: `esim` (many-to-one), `user` (many-to-one).

---

### WebhookEvent

Idempotent delivery log for inbound webhooks (eSIM + payment).

| Field        | Type      | Notes                                                        |
| ------------ | --------- | ------------------------------------------------------------ |
| `id`         | `String`  | `@id @default(cuid())`                                       |
| `provider`   | `String`  | `"mock"` / `"stripe"` / `"airalo"` / etc.                    |
| `eventType`  | `String`  | normalized event type (`"usage.update"`, `"payment.succeeded"`, etc.) |
| `externalId` | `String?` | provider's event id — used for dedup                         |
| `payload`    | `String`  | raw JSON body                                                |
| `processed`  | `Boolean` | default `false`; set `true` after side effects applied       |
| `error`      | `String?` | error message if processing failed                           |
| `createdAt`  | `DateTime`| `@default(now())`                                            |
| `processedAt`| `DateTime?`| set when `processed` flipped to `true`                     |

**Constraints**: `@@unique([provider, externalId])` — the dedup key. A
replayed webhook with the same `(provider, externalId)` is short-circuited.

**Indexes**: `@@index([provider, eventType])`.

---

### AuditLog

Append-only audit trail. Every financial / provisioning event writes a row.

| Field        | Type      | Notes                                                        |
| ------------ | --------- | ------------------------------------------------------------ |
| `id`         | `String`  | `@id @default(cuid())`                                       |
| `userId`     | `String?` | FK → `User.id`, SetNull on user delete                       |
| `orderId`    | `String?` | referenced order (no FK — order id is just stored as a string) |
| `action`     | `String`  | e.g. `"order.created"`, `"payment.confirmed"`, `"esim.provisioned"` |
| `entity`     | `String`  | `"order"` \| `"esim"` \| `"payment"` \| `"plan"` \| `"user"` |
| `entityId`   | `String?` | id of the referenced entity                                  |
| `detail`     | `String?` | JSON string: structured details                              |
| `ip`         | `String?` | client IP at the time of the action                          |
| `createdAt`  | `DateTime`| `@default(now())`                                            |

**Indexes**: `@@index([userId])`, `@@index([entity, entityId])`.

**Relations**: `user` (many-to-one, optional — SetNull on delete).

`orderId` is a plain string (no FK) so audit log rows survive order
deletion (which itself shouldn't happen — orders are append-only — but the
schema is defensive).

---

### PricingRule

Markup rule for the pricing engine.

| Field        | Type      | Notes                                                            |
| ------------ | --------- | ---------------------------------------------------------------- |
| `id`         | `String`  | `@id @default(cuid())`                                           |
| `name`       | `String`  | display name (e.g. `"Africa 35%"`)                               |
| `type`       | `String`  | `"fixed"` \| `"percentage"`                                      |
| `value`      | `Int`     | fixed: minor units; percentage: percent integer (30 = 30%)       |
| `scope`      | `String`  | `"global"` (default) \| `"country"` \| `"region"`                |
| `scopeValue` | `String?` | countryCode (for `country` scope) or region name (for `region`)  |
| `priority`   | `Int`     | default `0`; higher wins                                          |
| `active`     | `Boolean` | default `true`                                                   |
| `createdAt`  | `DateTime`| `@default(now())`                                                |
| `updatedAt`  | `DateTime`| `@updatedAt`                                                     |

**Indexes**: `@@index([scope, scopeValue])`.

The seed script installs four default rules (Africa 35%, Europe 25%, North
America 25%, Global 30%). The pricing engine picks the highest-priority
matching rule for a given plan's country/region and applies it to the
wholesale price.

---

### Notification

Outbound notification log. The dev implementation just writes a row; the
interface is ready for email / SMS / push / WhatsApp adapters.

| Field        | Type      | Notes                                                            |
| ------------ | --------- | ---------------------------------------------------------------- |
| `id`         | `String`  | `@id @default(cuid())`                                           |
| `userId`     | `String?` | FK → `User.id` (optional — some notifications are system-wide)   |
| `channel`    | `String`  | `"email"` \| `"sms"` \| `"push"` \| `"whatsapp"` \| `"log"`      |
| `event`      | `String`  | e.g. `"payment.successful"`, `"esim.provisioned"`, `"topup.successful"` |
| `recipient`  | `String?` | email / phone / device token                                     |
| `subject`    | `String?` |                                                                  |
| `body`       | `String`  |                                                                  |
| `status`     | `String`  | `"sent"` (default) \| `"failed"`                                 |
| `createdAt`  | `DateTime`| `@default(now())`                                                |

**Indexes**: `@@index([userId])`, `@@index([event])`.

The notification event types are defined in
[`src/lib/notifications/service.ts`](../src/lib/notifications/service.ts):

```ts
type NotificationEvent =
  | "order.confirmed"
  | "payment.successful"
  | "esim.provisioned"
  | "esim.installation_available"
  | "esim.expiring"
  | "esim.data_nearly_exhausted"
  | "topup.successful";
```

---

## Key Constraints

The schema uses unique constraints as the primary idempotency mechanism.

| Constraint                                | On Model      | Purpose                                                  |
| ----------------------------------------- | ------------- | -------------------------------------------------------- |
| `User.email @unique`                      | `User`        | One account per email.                                   |
| `Session.token @unique`                   | `Session`     | Lookup by token.                                         |
| `PasswordResetToken.token @unique`        | `PasswordResetToken` | One-time use.                                    |
| `EmailVerificationToken.token @unique`    | `EmailVerificationToken` | One-time use.                                |
| `Plan.(providerId, providerPlanId) @unique` | `Plan`      | One row per provider-native plan; upsert key for sync.   |
| `Order.idempotencyKey @unique`            | `Order`       | Idempotent order creation (no duplicates on retry).      |
| `Payment.idempotencyKey @unique`          | `Payment`     | Idempotent payment intent creation.                      |
| `ESIM.orderId @unique`                    | `ESIM`        | One eSIM per order (business rule 3).                    |
| `TopUp.idempotencyKey @unique`            | `TopUp`       | Idempotent top-up purchase (no double charge).           |
| `WebhookEvent.(provider, externalId) @unique` | `WebhookEvent` | Idempotent webhook delivery (no double application). |

These constraints are the **last line of defense** against duplicates. The
service layer checks for existing records before inserting (early
short-circuit), and the provider-level idempotency keys prevent duplicates
at the provider. But if both layers fail (race, bug, provider
misbehavior), the DB constraint guarantees we don't end up with two orders
for one payment or two eSIMs for one order.

---

## Indexes

Indexes are chosen to support the most common query patterns.

| Model          | Index                              | Supports                                                      |
| -------------- | ---------------------------------- | ------------------------------------------------------------- |
| `Session`      | `@@index([userId])`                | List a user's sessions (admin / account management)           |
| `PasswordResetToken` | `@@index([userId])`           | Find tokens for a user                                        |
| `EmailVerificationToken` | `@@index([userId])`          | Find tokens for a user                                        |
| `Plan`         | `@@index([countryCode])`           | Filter plans by country on `/esim`                            |
| `Plan`         | `@@index([region])`                | Filter plans by region                                        |
| `Plan`         | `@@index([status])`                | List active plans only                                        |
| `Order`        | `@@index([userId])`                | List a user's orders (`/dashboard/orders`)                    |
| `Order`        | `@@index([status])`                | Admin: filter orders by state                                 |
| `Order`        | `@@index([paymentStatus])`         | Admin: filter orders by payment status                        |
| `Payment`      | `@@index([orderId])`               | List payments for an order                                    |
| `Payment`      | `@@index([status])`                | Admin: filter payments                                        |
| `ESIM`         | `@@index([userId])`                | List a user's eSIMs (`/dashboard/esims`)                      |
| `ESIM`         | `@@index([status])`                | Admin: filter eSIMs by status                                 |
| `ESIM`         | `@@index([iccid])`                 | Admin: lookup by ICCID                                        |
| `Usage`        | `@@index([esimId])`                | Fetch usage history for an eSIM                               |
| `TopUp`        | `@@index([esimId])`                | List top-ups for an eSIM                                      |
| `WebhookEvent` | `@@index([provider, eventType])`   | Admin: inspect webhook history by provider / event type       |
| `AuditLog`     | `@@index([userId])`                | Audit trail by user                                           |
| `AuditLog`     | `@@index([entity, entityId])`      | Audit trail by entity (e.g. all events for an order)          |
| `PricingRule`  | `@@index([scope, scopeValue])`     | Pricing engine: find matching rules for a plan                |
| `Notification` | `@@index([userId])`                | List notifications for a user                                 |
| `Notification` | `@@index([event])`                 | Find notifications by event type                              |

### What's NOT indexed

- `Plan.name`, `Plan.description` — text search is done in TS after fetching
  (the catalog is small enough). For a larger catalog, add a full-text
  search index (PostgreSQL `tsvector`).
- `Order.paymentReference`, `Payment.providerReference` — these are looked
  up by exact match in webhook handlers, but the row counts are low enough
  that the sequential scan is fine. Add indexes if webhook volume becomes
  a bottleneck.
- `ESIM.providerESIMId` — looked up in the eSIM webhook handler. Same
  reasoning; add an index if needed.

---

## See Also

- [`prisma/schema.prisma`](../prisma/schema.prisma) — the canonical schema
- [`prisma/seed.ts`](../prisma/seed.ts) — the seed script
- [`architecture.md`](architecture.md) — data model overview diagram
- [`src/lib/money.ts`](../src/lib/money.ts) — money helpers
- [`src/lib/db.ts`](../src/lib/db.ts) — Prisma client singleton
