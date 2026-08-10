/**
 * Virtual number lifecycle state machine.
 *
 * DISCOVERED → AVAILABLE → RESERVED → PROVISIONING → CONFIGURING → ACTIVE
 *                  ↓            ↓           ↓             ↓           ↓
 *               FAILED      FAILED      FAILED        FAILED    SUSPENDED → ACTIVE
 *                                                                      ↓
 *                                                                  RELEASING → RELEASED
 */

export type NumberStatus =
  | "discovered"
  | "available"
  | "reserved"
  | "provisioning"
  | "configuring"
  | "active"
  | "suspended"
  | "releasing"
  | "released"
  | "failed";

const TRANSITIONS: Record<NumberStatus, NumberStatus[]> = {
  discovered: ["available"],
  available: ["reserved", "released"],
  reserved: ["provisioning", "available", "failed"],
  provisioning: ["configuring", "failed"],
  configuring: ["active", "failed"],
  active: ["suspended", "releasing"],
  suspended: ["active", "releasing"],
  releasing: ["released"],
  released: [],
  failed: ["reserved", "provisioning"],
};

export function canTransitionNumber(from: NumberStatus, to: NumberStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertNumberTransition(from: NumberStatus, to: NumberStatus): void {
  if (!canTransitionNumber(from, to)) {
    throw new Error(`Illegal number transition ${from} -> ${to}`);
  }
}

export const ACTIVE_NUMBER_STATUSES: NumberStatus[] = ["active", "suspended"];
