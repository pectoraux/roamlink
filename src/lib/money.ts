/**
 * Money utilities.
 *
 * Monetary values are stored as integer MINOR UNITS (e.g. cents) across the
 * system — never floating point. This module is the single source of truth for
 * parsing, formatting and arithmetic on money.
 *
 * 1 major unit = 100 minor units (for 2-decimal currencies like USD/EUR/XOF*).
 * Note: XOF is technically a 0-decimal currency, but for MVP simplicity we
 * treat all supported currencies as 2-decimal. The architecture supports
 * adding currency precision metadata later.
 */

export type Currency = "USD" | "EUR" | "XOF";

export const CURRENCIES: Currency[] = ["USD", "EUR", "XOF"];

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  USD: "$",
  EUR: "€",
  XOF: "CFA ",
};

/** A monetary amount expressed in minor units (integer). */
export type Money = {
  amount: number; // minor units
  currency: Currency;
};

/** Parse a decimal major-unit string/number into minor units. */
export function toMinorUnits(value: string | number, currency: Currency = "USD"): number {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) throw new Error(`Invalid money value: ${value}`);
  return Math.round(n * 100);
}

/** Convert minor units back to a decimal major-unit number. */
export function toMajorUnits(minor: number): number {
  return minor / 100;
}

/** Format minor units as a human-readable currency string. */
export function formatMoney(minor: number, currency: Currency = "USD"): string {
  const major = toMajorUnits(minor);
  const symbol = CURRENCY_SYMBOLS[currency];
  return `${symbol}${major.toFixed(2)}`;
}

/** Add two minor-unit amounts (same currency). */
export function addMoney(a: number, b: number): number {
  return a + b;
}

/** Subtract minor-unit amounts (same currency). */
export function subMoney(a: number, b: number): number {
  return a - b;
}

/** Multiply a minor-unit amount by a factor, rounding to nearest minor unit. */
export function multiplyMoney(minor: number, factor: number): number {
  return Math.round(minor * factor);
}

/** Apply a percentage (e.g. 30 for 30%) to a minor-unit amount. */
export function applyPercent(minor: number, percent: number): number {
  return Math.round((minor * percent) / 100);
}

/** Validate a currency string. */
export function isCurrency(c: string): c is Currency {
  return CURRENCIES.includes(c as Currency);
}
