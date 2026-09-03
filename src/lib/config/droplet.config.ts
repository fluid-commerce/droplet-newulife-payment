/**
 * Droplet Configuration
 *
 * What this droplet registers with Fluid when a company installs it.
 *
 * ## Why callbacks live here and not in a table
 *
 * The sibling migrations read their callback list from a `callbacks` table,
 * synced from Fluid's definition catalogue and edited on an admin screen. This
 * droplet forked from an OLDER template: it has no `callbacks` table, no
 * `CallbackSyncService`, and no admin callbacks screen. Registration was a curl
 * command in callbacks_registration.md, run by hand.
 *
 * So the list is code. That is a real improvement rather than a compromise —
 * this is the only place a definition name is written down, and it is reviewed.
 *
 * ## The definition name
 *
 * `redirect_cart_payment` is verified against fluid's own catalogue at
 * app/lib/callback_definitions/redirect_cart_payment.yml. The full valid set is
 * exactly the filenames in that directory; a name that is not one of them
 * produces a registration Fluid will never call, and nothing surfaces that.
 *
 * The Rails ROUTE is `POST /get_redirect_url`, which is a local name and not a
 * definition name. The Next route is `POST /api/callbacks/redirect-cart-payment`
 * — the kebab-cased definition name. See CUTOVER.md.
 */

import type { DropletConfig } from "./schema";

export const dropletConfig: DropletConfig = {
  callbacks: [
    {
      enabled: true,
      /** Exactly the `name:` from redirect_cart_payment.yml in fluid. */
      definitionName: "redirect_cart_payment",
      /** Appended to FLUID_DROPLET_URL when the registration is created. */
      path: "/api/callbacks/redirect-cart-payment",
      /**
       * Matches the timeout in callbacks_registration.md. Fluid caps this at
       * 20s, and this callback makes up to four sequential third-party calls,
       * so there is no headroom to give away.
       */
      timeoutInSeconds: 20,
    },
  ],

  /**
   * Per-company webhooks, registered on install.
   *
   * `order.external_id_synced` is real — fluid's Webhook::TopicRegistry lists
   * `order: [..., external_id_synced]` — and it is the second half of the
   * recording precondition, so it is ENABLED here.
   *
   * `company_droplet.created` is deliberately absent. The Rails initializer
   * carried it commented out with a TODO doubting it existed; it is not a topic
   * in the registry, and the TODO was right.
   */
  webhooks: [
    {
      enabled: true,
      resource: "order",
      event: "external_id_synced",
      description:
        "Fluid has synced the order to ByDesign and knows its OrderID",
    },
  ],
};

/** The definition names this droplet serves. Used by the backfill's coverage check. */
export const enabledCallbackDefinitions = dropletConfig.callbacks
  .filter((callback) => callback.enabled)
  .map((callback) => callback.definitionName);
