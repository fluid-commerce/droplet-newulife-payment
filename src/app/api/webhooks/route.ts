/**
 * Webhook endpoint.
 *
 * Port of app/controllers/webhooks_controller.rb, wrapped in the SDK's
 * `withFluidWebhook`.
 *
 * Webhooks are not the checkout path, so this route refuses loudly: an
 * unverified request gets a 401 and nothing runs. That is the opposite of the
 * callback routes, and it is deliberate — a rejected webhook is a retry, while
 * a rejected callback is a broken cart.
 *
 * What the wrapper replaces, and why it is an improvement on the Ruby:
 *
 *  - `droplet.installed` was FULLY UNAUTHENTICATED.
 *    `WebhooksController#droplet_installed_for_first_time?` skips
 *    `authenticate_webhook_token` for it, and unlike the template this droplet
 *    DELETED the compensating `validate_droplet_authorization` — the identifier
 *    appears nowhere in `app/`, `lib/`, `config/` or `test/`. So a POST to
 *    `/webhook` with `{"resource":"droplet","event":"installed","company":{…}}`
 *    creates or updates a `companies` row from the request body, including
 *    `webhook_verification_token`, and every subsequent webhook then
 *    authenticates against the token the attacker supplied.
 *
 *    Here these events verify by HMAC against the shared bootstrap secret and
 *    NOTHING else. Not against a company token: the install handler selects the
 *    company from the payload, so accepting one would let the holder of ANY
 *    company's token sign an install naming ANOTHER company's shop and overwrite
 *    its credentials. The droplet-uuid check survives as a routing guard inside
 *    the handler rather than as the authentication.
 *
 *  - Every other event was authenticated against `company.webhook_verification_token`
 *    with `secure_compare` — genuinely better than the template — but the company
 *    was found by `company_droplet_uuid` FIRST, which is the DROPLET's uuid and
 *    identical on every installation row. With more than one installation that
 *    lookup returns an arbitrary company and the webhook is checked against its
 *    token. Here the tenant is resolved from `droplet_installation_uuid`, then
 *    `fluid_company_id`, and never from the droplet-wide uuid.
 */

import { withFluidWebhook, INSTALL_EVENT } from "@fluid-app/droplet-sdk/next";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { routeEvent, hasHandler } from "@/lib/events";
import { initializeHandlers } from "@/lib/handlers";

initializeHandlers();

/**
 * Events allowed to authenticate with the shared bootstrap secret.
 *
 * `droplet.installed` has to be here: it is the event that delivers the
 * company's own token, so no per-company secret exists yet.
 *
 * `droplet.uninstalled` is here too, because Fluid signs it with the same
 * droplet-level webhook as the install — created on Fluid's droplet settings
 * screen with the shared `auth_token`, not with any company's token. (This
 * droplet has no WebhookManager; that template file was never in this fork.)
 */
const BOOTSTRAP_EVENTS = [INSTALL_EVENT, "droplet.uninstalled"];

export const POST = withFluidWebhook(
  {
    name: "droplet",
    bootstrapSecret: process.env.FLUID_WEBHOOK_AUTH_TOKEN,
    bootstrapEvents: BOOTSTRAP_EVENTS,

    /**
     * Finds the candidate secret for a webhook, from untrusted routing hints.
     *
     * Unlike a callback, a webhook's secret is per-company, so the tenant has
     * to be guessed before verification and only trusted afterwards. Returning
     * null means no candidate — which for a bootstrap event is fine, the shared
     * secret is tried next, and for anything else is an auth failure.
     */
    async resolve({ dri, fluidShop, companyId }) {
      const company = dri
        ? await prisma.company.findFirst({
            where: { dropletInstallationUuid: dri },
          })
        : companyId !== undefined
          ? await prisma.company.findFirst({
              where: { fluidCompanyId: BigInt(companyId) },
            })
          : fluidShop
            ? await prisma.company.findFirst({ where: { fluidShop } })
            : null;

      if (!company?.webhookVerificationToken) return null;

      return {
        secret: company.webhookVerificationToken,
        principal: company,
      };
    },
  },

  async ({ event, payload }) => {
    console.log(`[Webhook] Received: ${event}`);

    // Rails answered 204 when nothing was registered for the event, and 202
    // when a job was enqueued. Both are kept; the difference is that the work
    // has actually finished by the time 202 is returned. See the note in
    // src/lib/events/event-handler.ts on why this runs inline.
    if (!hasHandler(event)) {
      return new NextResponse(null, { status: 204 });
    }

    try {
      const handled = await routeEvent(event, payload);
      return new NextResponse(null, { status: handled ? 202 : 204 });
    } catch (error) {
      // The payload is never logged here: it carries authentication_token and
      // webhook_verification_token on an install.
      console.error(
        `[Webhook] Handler failed for ${event}:`,
        error instanceof Error ? error.message : error,
      );
      // A 5xx is a retry signal to Fluid, which is what a transient database or
      // Fluid API failure deserves.
      return NextResponse.json(
        { error: "internal error" },
        { status: 500 },
      );
    }
  },
);

export function GET() {
  return NextResponse.json({ status: "ok", service: "newulife-payment-webhooks" });
}
