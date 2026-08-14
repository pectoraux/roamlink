-- Phase 2B.2.3 — Reconciliation reason field
-- Adds reconciliationReason to TenantBalanceReservation to distinguish:
--   LEDGER_POSTING_FAILED (safe to retry settlement if fulfillment is now success)
--   FULFILLMENT_UNKNOWN (must NOT settle until fulfillment is confirmed)
--   TENANT_TRANSACTION_FAILED (ledger posted, repair operational projection only)
--   OTHER

ALTER TABLE "TenantBalanceReservation" ADD COLUMN "reconciliationReason" TEXT;
