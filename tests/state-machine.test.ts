/**
 * Order state machine tests.
 * Verifies legal/illegal transitions and terminal states.
 */

import { describe, expect, it } from "bun:test";
import { canTransition, assertTransition, TERMINAL_STATUSES, FAILURE_STATUSES } from "@/lib/orders/state-machine";
import { AppError } from "@/lib/errors";

describe("order state machine", () => {
  describe("happy path transitions", () => {
    it("allows PLAN_SELECTED → CHECKOUT_CREATED", () => {
      expect(canTransition("PLAN_SELECTED", "CHECKOUT_CREATED")).toBe(true);
    });
    it("allows CHECKOUT_CREATED → PAYMENT_PENDING", () => {
      expect(canTransition("CHECKOUT_CREATED", "PAYMENT_PENDING")).toBe(true);
    });
    it("allows PAYMENT_PENDING → PAYMENT_CONFIRMED", () => {
      expect(canTransition("PAYMENT_PENDING", "PAYMENT_CONFIRMED")).toBe(true);
    });
    it("allows PAYMENT_CONFIRMED → ESIM_PROVISIONING", () => {
      expect(canTransition("PAYMENT_CONFIRMED", "ESIM_PROVISIONING")).toBe(true);
    });
    it("allows ESIM_PROVISIONING → ESIM_PROVISIONED", () => {
      expect(canTransition("ESIM_PROVISIONING", "ESIM_PROVISIONED")).toBe(true);
    });
    it("allows ESIM_PROVISIONED → COMPLETED", () => {
      expect(canTransition("ESIM_PROVISIONED", "COMPLETED")).toBe(true);
    });
  });

  describe("failure transitions", () => {
    it("allows PAYMENT_PENDING → PAYMENT_FAILED", () => {
      expect(canTransition("PAYMENT_PENDING", "PAYMENT_FAILED")).toBe(true);
    });
    it("allows PAYMENT_CONFIRMED → PROVISIONING_FAILED", () => {
      expect(canTransition("PAYMENT_CONFIRMED", "PROVISIONING_FAILED")).toBe(true);
    });
    it("allows ESIM_PROVISIONING → PROVISIONING_FAILED", () => {
      expect(canTransition("ESIM_PROVISIONING", "PROVISIONING_FAILED")).toBe(true);
    });
    it("allows PROVISIONING_FAILED → ESIM_PROVISIONING (retry)", () => {
      expect(canTransition("PROVISIONING_FAILED", "ESIM_PROVISIONING")).toBe(true);
    });
  });

  describe("illegal transitions", () => {
    it("rejects PLAN_SELECTED → COMPLETED (skipping steps)", () => {
      expect(canTransition("PLAN_SELECTED", "COMPLETED")).toBe(false);
    });
    it("rejects COMPLETED → PAYMENT_PENDING (going backwards from terminal)", () => {
      expect(canTransition("COMPLETED", "PAYMENT_PENDING")).toBe(false);
    });
    it("rejects CANCELLED → any (terminal)", () => {
      expect(canTransition("CANCELLED", "COMPLETED")).toBe(false);
      expect(canTransition("CANCELLED", "PAYMENT_PENDING")).toBe(false);
    });
    it("rejects REFUNDED → any (terminal)", () => {
      expect(canTransition("REFUNDED", "COMPLETED")).toBe(false);
    });
  });

  describe("assertTransition", () => {
    it("does not throw for legal transitions", () => {
      expect(() => assertTransition("PLAN_SELECTED", "CHECKOUT_CREATED")).not.toThrow();
    });
    it("throws AppError for illegal transitions", () => {
      expect(() => assertTransition("COMPLETED", "PAYMENT_PENDING")).toThrow(AppError);
    });
  });

  describe("terminal and failure statuses", () => {
    it("identifies terminal statuses", () => {
      expect(TERMINAL_STATUSES).toContain("COMPLETED");
      expect(TERMINAL_STATUSES).toContain("CANCELLED");
      expect(TERMINAL_STATUSES).toContain("REFUNDED");
      expect(TERMINAL_STATUSES).not.toContain("PAYMENT_PENDING");
    });
    it("identifies failure statuses", () => {
      expect(FAILURE_STATUSES).toContain("PAYMENT_FAILED");
      expect(FAILURE_STATUSES).toContain("PROVISIONING_FAILED");
    });
  });
});
