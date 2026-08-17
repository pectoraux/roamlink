/**
 * Phase 9.5.5 — Reason-Code Protocol Compatibility & Error Semantics (DB-backed)
 *
 * Tests:
 *   I1: VALID — all codes in registry → codes exposed, integrity VALID
 *   I2: ABSENT — null/undefined → empty codes, integrity ABSENT
 *   I3: MALFORMED — corrupt JSON → empty codes, integrity MALFORMED, logged
 *   I4: UNKNOWN_CODE — valid JSON with unknown code → valid subset exposed,
 *       integrity UNKNOWN_CODE, unknownCodes tracked, logged
 *   I5: Producer validation still fail-closed (validateReasonCodes throws)
 *   I6: Reserved codes (BATTERY_SAVER_CONTEXT etc.) are in the registry
 *       but distinguishable from currently-emitted codes
 *   I7: Round-trip: serialize → parseReasonCodesWithIntegrity → VALID
 */

import { describe, expect, it } from "bun:test";
import {
  REASON_CODES,
  isValidReasonCode,
  validateReasonCodes,
  serializeReasonCodes,
  parseReasonCodesWithIntegrity,
  parseReasonCodes,
  type ReasonCode,
  type ReasonCodeIntegrity,
} from "@roamlink/shared";

describe("Phase 9.5.5 — Reason-Code Protocol Compatibility & Error Semantics", () => {

  // I1: VALID
  it("I1: all codes in registry → VALID integrity", () => {
    const json = serializeReasonCodes(["RELIABILITY_REQUIREMENT", "BUDGET_CONSTRAINT"]);
    const result = parseReasonCodesWithIntegrity(json);
    expect(result.integrity).toBe("VALID");
    expect(result.codes).toEqual(["RELIABILITY_REQUIREMENT", "BUDGET_CONSTRAINT"]);
    expect(result.unknownCodes).toEqual([]);
  });

  // I2: ABSENT
  it("I2: null/undefined → ABSENT integrity, empty codes", () => {
    expect(parseReasonCodesWithIntegrity(null).integrity).toBe("ABSENT");
    expect(parseReasonCodesWithIntegrity(undefined).integrity).toBe("ABSENT");
    expect(parseReasonCodesWithIntegrity("").integrity).toBe("ABSENT");
    expect(parseReasonCodesWithIntegrity(null).codes).toEqual([]);
  });

  // I3: MALFORMED
  it("I3: corrupt JSON → MALFORMED integrity, empty codes", () => {
    const result = parseReasonCodesWithIntegrity("not valid json");
    expect(result.integrity).toBe("MALFORMED");
    expect(result.codes).toEqual([]);
    expect(result.unknownCodes).toEqual([]);
  });

  it("I3b: non-array JSON → MALFORMED", () => {
    const result = parseReasonCodesWithIntegrity('{"not": "an array"}');
    expect(result.integrity).toBe("MALFORMED");
    expect(result.codes).toEqual([]);
  });

  it("I3c: array with non-string element → MALFORMED", () => {
    const result = parseReasonCodesWithIntegrity('[123, "VALID"]');
    expect(result.integrity).toBe("MALFORMED");
  });

  // I4: UNKNOWN_CODE
  it("I4: unknown code → UNKNOWN_CODE integrity, valid subset exposed", () => {
    const json = JSON.stringify(["RELIABILITY_REQUIREMENT", "FAKE_CODE", "BUDGET_CONSTRAINT"]);
    const result = parseReasonCodesWithIntegrity(json);
    expect(result.integrity).toBe("UNKNOWN_CODE");
    expect(result.codes).toEqual(["RELIABILITY_REQUIREMENT", "BUDGET_CONSTRAINT"]);
    expect(result.unknownCodes).toEqual(["FAKE_CODE"]);
  });

  it("I4b: only unknown codes → UNKNOWN_CODE, empty valid codes", () => {
    const json = JSON.stringify(["FAKE_1", "FAKE_2"]);
    const result = parseReasonCodesWithIntegrity(json);
    expect(result.integrity).toBe("UNKNOWN_CODE");
    expect(result.codes).toEqual([]);
    expect(result.unknownCodes).toEqual(["FAKE_1", "FAKE_2"]);
  });

  // I5: Producer validation still fail-closed
  it("I5: validateReasonCodes throws on unknown code (producer fail-closed)", () => {
    expect(() => validateReasonCodes(["VALID", "FAKE"])).toThrow(/Unknown reason code/);
    expect(() => validateReasonCodes(["RELIABILITY_REQUIREMENT"])).not.toThrow();
    expect(() => validateReasonCodes([])).not.toThrow();
  });

  it("I5b: serializeReasonCodes validates before serializing", () => {
    expect(() => serializeReasonCodes(["FAKE" as ReasonCode])).toThrow(/Unknown reason code/);
    const serialized = serializeReasonCodes(["RELIABILITY_REQUIREMENT", "BUDGET_CONSTRAINT"]);
    expect(serialized).toBe('["RELIABILITY_REQUIREMENT","BUDGET_CONSTRAINT"]');
  });

  // I6: Reserved vs emitted codes
  it("I6: registry contains reserved codes (not yet emitted)", () => {
    const reserved = ["BATTERY_SAVER_CONTEXT", "PREFERRED_TRANSPORT", "NO_BETTER_RESOURCE", "INTENT_SUPERSEDED"];
    for (const code of reserved) {
      expect(isValidReasonCode(code)).toBe(true);
      expect(REASON_CODES).toContain(code);
    }
    // Registry has 16 total codes
    expect(REASON_CODES.length).toBe(16);
  });

  // I7: Round-trip
  it("I7: serialize → parseReasonCodesWithIntegrity → VALID", () => {
    const codes: ReasonCode[] = ["RELIABILITY_REQUIREMENT", "BUDGET_CONSTRAINT", "POLICY_CONSTRAINT", "QUALITY_ACCEPTABLE"];
    const json = serializeReasonCodes(codes);
    const result = parseReasonCodesWithIntegrity(json);
    expect(result.integrity).toBe("VALID");
    expect(result.codes).toEqual(codes);
    expect(result.unknownCodes).toEqual([]);
  });

  // I8: Backward-compatible parseReasonCodes still works
  it("I8: parseReasonCodes (backward-compatible) returns just the codes", () => {
    expect(parseReasonCodes(null)).toEqual([]);
    expect(parseReasonCodes("malformed")).toEqual([]);
    expect(parseReasonCodes(serializeReasonCodes(["RELIABILITY_REQUIREMENT"]))).toEqual(["RELIABILITY_REQUIREMENT"]);
    expect(parseReasonCodes(JSON.stringify(["RELIABILITY_REQUIREMENT", "FAKE"]))).toEqual(["RELIABILITY_REQUIREMENT"]);
  });
});
