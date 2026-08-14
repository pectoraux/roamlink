-- Phase 2B.2.5 — Projection reconciled flag
-- Adds projectionReconciled boolean to TenantBalanceReservation.
-- When false, the reconciliation worker checks/repairs the TenantTransaction.
-- When true, the worker skips it (scalability optimization — avoids scanning
-- every historical SETTLED reservation on every cron run).

ALTER TABLE "TenantBalanceReservation" ADD COLUMN "projectionReconciled" BOOLEAN NOT NULL DEFAULT false;
