/**
 * Fulfillment Registry — registers the default fulfillment adapters and
 * persistence handlers used by the orchestrator.
 *
 * Importing this module is enough to ensure the default ESIM adapter and
 * persistence handler are registered. New product types should register
 * their own adapters/handlers here (or in their own module imported here).
 */

import { registerAdapter, registerPersistenceHandler } from "./adapter";
import { ESIMFulfillmentAdapter } from "./esim-adapter";
import { ESIMFulfillmentPersistence } from "./esim-persistence";

let registered = false;

/** Register default adapters + persistence handlers. Idempotent. */
export function ensureDefaultFulfillmentRegistered(): void {
  if (registered) return;
  registered = true;
  registerAdapter(ESIMFulfillmentAdapter);
  registerPersistenceHandler(ESIMFulfillmentPersistence);
}

// Register on import.
ensureDefaultFulfillmentRegistered();
