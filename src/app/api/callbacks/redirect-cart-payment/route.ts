/**
 * `redirect_cart_payment` — leg ① of the money path.
 *
 * Port of `CheckoutCallbackController#get_redirect_url` and its route,
 * `POST /get_redirect_url`.
 *
 * ## The definition name
 *
 * `redirect_cart_payment`, verified against fluid's
 * app/lib/callback_definitions/redirect_cart_payment.yml. The Rails route name
 * (`get_redirect_url`) is a LOCAL name; the two are unrelated and only the
 * definition name is what Fluid matches on. The droplet's own registration
 * recipe (callbacks_registration.md) names the definition explicitly, which is
 * how the pair was confirmed rather than inferred.
 *
 * ## Authentication — this is net-new
 *
 * The Rails controller has no `before_action` at all. Anyone who could reach
 * `POST /get_redirect_url` could cause a ByDesign consumer to be created, a
 * Fluid customer to be created and a uPayments order to be opened. There has
 * never been a token to check, because registration was a hand-run curl that
 * discarded the `verification_token` Fluid issued once.
 *
 * `withFluidCallback` closes that: the request must carry a callback token
 * whose digest is stored, the HMAC over `{timestamp}.{body}` must verify
 * against the presented token, and the tenant comes from `registration.dri` and
 * from nothing else — no `x-fluid-shop` header, no company id from the body. A
 * valid signature proves which REGISTRATION signed, not who the request is
 * about, so a payload fallback would let the holder of tenant A's token sign a
 * request naming tenant B.
 *
 * That is why the rollout order in CUTOVER.md is not optional: the tokens have
 * to be in `fluid_callback_registrations` BEFORE this route serves traffic. A
 * refusal here answers 200, so a missing token looks exactly like a shopper who
 * could not be sent to pay.
 *
 * ## Everything answers 200
 *
 * Auth failure, malformed body and handler error all return the SAME neutral
 * body — see NEUTRAL_RESULT — so the route is not an oracle telling a caller
 * which of the three they hit. It is also the body the handler itself returns
 * when it cannot produce a URL.
 *
 * `{redirect_url: null, error_message: "..."}` is a shape the definition
 * explicitly allows, and Fluid shows the message and leaves the shopper on
 * checkout. There is no numeric field here for Fluid to apply, so unlike
 * `update_cart_tax` a neutral 200 cannot be mistaken for a real value. What
 * must never happen is a `redirect_url` that is not a live uPayments order.
 */

import { withFluidCallback } from "@fluid-app/droplet-sdk/next";
import { NextResponse } from "next/server";

import { callbackStore, resolvePrincipal } from "@/lib/callbacks";
import { getRedirectUrl, NEUTRAL_RESULT } from "@/lib/checkout";
import { redirectCartPaymentSchema } from "@/lib/upayments";

/** The single body this route ever returns when it has no URL to give. */
const neutral = () => NextResponse.json(NEUTRAL_RESULT);

export const POST = withFluidCallback(
  {
    definitions: ["redirect_cart_payment"],
    store: callbackStore,
    resolvePrincipal,
    name: "redirect-cart-payment",
    onAuthFailure: neutral,
    onInvalidBody: neutral,
    onHandlerError: neutral,
  },
  async ({ payload, principal: company, signal }) => {
    const parsed = redirectCartPaymentSchema.safeParse(payload);
    if (!parsed.success) {
      // Never log the body: it carries the shopper's address and email. This is
      // the `callback_params[:cart][:email]` NoMethodError case from Rails —
      // `cart` is a REQUIRED field in the definition, so a body without one is
      // exactly the malformed input that should get the neutral answer rather
      // than an HTTP 500.
      console.warn(
        `[redirect-cart-payment] Unusable payload for company ${company.id}`,
      );
      return neutral();
    }

    const result = await getRedirectUrl(parsed.data, signal);
    return NextResponse.json(result);
  },
);
