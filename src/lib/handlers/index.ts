/**
 * Event handler registration.
 *
 * Mirrors config/initializers/event_handler.rb, minus one line and plus
 * nothing:
 *
 *  - `droplet.installed` and `droplet.uninstalled` are real topics
 *    (fluid's Webhook::TopicRegistry lists `droplet: [installed, uninstalled]`).
 *  - `order.external_id_synced` is real and is half of the recording
 *    precondition.
 *  - `company_droplet.created` was already commented out in Ruby with a TODO
 *    doubting it existed. It is not in the topic registry; the TODO was right,
 *    so it is deleted rather than ported.
 *
 * `DropletReinstalledJob` is likewise not ported: it was never registered in
 * the initializer and `droplet.reinstalled` is not a topic. A reinstall arrives
 * as a fresh `droplet.installed`, which handleDropletInstalled handles by
 * clearing `uninstalledAt`.
 */

import { registerHandler } from "@/lib/events";
import { handleOrderExternalIdSynced } from "@/lib/payments";
import { handleDropletInstalled } from "./droplet-installed";
import { handleDropletUninstalled } from "./droplet-uninstalled";

let initialized = false;

export function initializeHandlers(): void {
  if (initialized) return;
  initialized = true;

  registerHandler("droplet.installed", handleDropletInstalled);
  registerHandler("droplet.uninstalled", handleDropletUninstalled);
  registerHandler("order.external_id_synced", async (payload) => {
    await handleOrderExternalIdSynced(payload);
  });
}

export { handleDropletInstalled } from "./droplet-installed";
export { handleDropletUninstalled } from "./droplet-uninstalled";
export { findCompanyForPayload } from "./find-company";
