/** Formatting helpers (isomorphic — usable on server and client). */

import { format, formatDistanceToNow } from "date-fns";

export function formatPrice(minor: number, currency = "USD"): string {
  const symbols: Record<string, string> = { USD: "$", EUR: "€", XOF: "CFA " };
  const symbol = symbols[currency] ?? "";
  return `${symbol}${(minor / 100).toFixed(2)}`;
}

export function formatDataSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

export function formatDate(date: string | Date): string {
  return format(new Date(date), "MMM d, yyyy");
}

export function formatDateTime(date: string | Date): string {
  return format(new Date(date), "MMM d, yyyy 'at' h:mm a");
}

export function formatRelative(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

/** Convert ISO country code to flag emoji. */
export function countryFlag(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return "🌐";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/** Status badge color mapping. */
export function statusColor(status: string): string {
  switch (status.toLowerCase()) {
    case "active":
    case "completed":
    case "succeeded":
    case "complited":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
    case "pending":
    case "payment_pending":
    case "pay_pending":
    case "plan_selected":
    case "checkout_created":
      return "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
    case "expired":
    case "exhausted":
    case "cancelled":
    case "failed":
    case "payment_failed":
    case "provisioning_failed":
      return "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
    case "suspended":
      return "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function prettifyStatus(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
