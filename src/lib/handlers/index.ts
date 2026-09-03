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
    const outcome = await handleOrderExternalIdSynced(payload);

    // Same reasoning as the Moola route: this app has no queue, so a recording
    // run that failed transiently is retried by the DELIVERY. Throwing makes
    // the webhook route answer 500, which Fluid re-sends. Idempotent because of
    // `bydesign_payment_receipts`, and bounded by MAX_RECORDING_ATTEMPTS.
    if (outcome.recordingNeedsRetry) {
      throw new Error(
        "ByDesign recording did not complete; retry this delivery",
      );
    }
  });
}

export { handleDropletInstalled } from "./droplet-installed";
export { handleDropletUninstalled } from "./droplet-uninstalled";
export { findCompanyForPayload } from "./find-company";
