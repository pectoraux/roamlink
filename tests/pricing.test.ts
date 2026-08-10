/**
 * Pricing engine tests.
 * Verifies wholesale + markup = retail with no floating-point arithmetic.
 */

import { describe, expect, it } from "bun:test";
import { computeRetailPrice } from "@/lib/plans/pricing";
import { toMinorUnits, toMajorUnits, formatMoney, addMoney, applyPercent } from "@/lib/money";

describe("money", () => {
  it("converts major units to minor units", () => {
    expect(toMinorUnits(5.2, "USD")).toBe(520);
    expect(toMinorUnits(9.45, "USD")).toBe(945);
    expect(toMinorUnits(0.01, "USD")).toBe(1);
  });

  it("converts minor units back to major", () => {
    expect(toMajorUnits(945)).toBe(9.45);
    expect(toMajorUnits(0)).toBe(0);
  });

  it("formats money with currency symbol", () => {
    expect(formatMoney(945, "USD")).toBe("$9.45");
    expect(formatMoney(200, "EUR")).toBe("€2.00");
  });

  it("adds money in minor units", () => {
    expect(addMoney(500, 445)).toBe(945);
  });

  it("applies percentage without float drift", () => {
    expect(applyPercent(700, 35)).toBe(245); // 35% of $7.00 = $2.45
    expect(applyPercent(100, 30)).toBe(30);
  });

  it("never uses floating point for money", () => {
    // The classic float problem: 0.1 + 0.2 !== 0.3
    // Our minor-unit approach avoids this entirely.
    const a = toMinorUnits("0.10");
    const b = toMinorUnits("0.20");
    const sum = addMoney(a, b);
    expect(toMajorUnits(sum)).toBe(0.3);
  });
});

describe("pricing engine", () => {
  it("applies default 30% markup when no rules exist", async () => {
    // $4 wholesale → 30% = $1.20 markup → $5.20 retail
    const result = await computeRetailPrice({
      wholesaleMinor: 400,
      countryCode: "XX",
      region: "Test",
      currency: "USD",
    });
    expect(result.retailMinor).toBe(520);
    expect(result.wholesaleMinor).toBe(400);
    expect(result.ruleType).toBe("percentage");
  });

  it("never exposes wholesale in the retail calculation result incorrectly", async () => {
    const result = await computeRetailPrice({
      wholesaleMinor: 1000,
      countryCode: "GH",
      region: "Africa",
      currency: "USD",
    });
    // Retail must be >= wholesale (markup is additive, never negative)
    expect(result.retailMinor).toBeGreaterThanOrEqual(result.wholesaleMinor);
  });
});
