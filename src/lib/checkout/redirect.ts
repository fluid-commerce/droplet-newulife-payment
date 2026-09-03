/**
 * Leg ① — `redirect_cart_payment`.
 *
 * Port of `CheckoutCallbackController#get_redirect_url`.
 *
 * Given a cart, this makes sure the shopper exists in ByDesign, in Fluid and in
 * uPayments, opens a uPayments hosted-checkout order, and hands back the URL
 * the shopper is redirected to. Two of those four are IRREVERSIBLE from this
 * droplet's side (the ByDesign consumer and the Fluid customer); the uPayments
 * order merely expires.
 *
 * ## The response contract, and why every failure is a 200
 *
 * `redirect_cart_payment.yml` declares
 * `anyOf: [required: [redirect_url], required: [error_message]]`, both nullable
 * strings, and `criticality: checkout_blocking`. There is no numeric field for
 * Fluid to trust, so unlike `update_cart_tax` there is no "a 200 carrying a zero
 * gets applied" hazard here. The two useful shapes are:
 *
 *   200 {redirect_url: null, error_message: "…"} — shopper stays on checkout
 *                                                  and is told why
 *   200 {redirect_url: "…"}                      — shopper is sent to pay
 *
 * A non-2xx is undefined by the schema and tells the shopper nothing. So: fail
 * open in the HTTP sense, fail CLOSED in the business sense. Never return a
 * `redirect_url` that is not a real uPayments order. The Rails code gets the
 * handled paths right and leaks HTTP 500s on the unhandled ones — a missing
 * `cart` key, an unparseable uPayments body, a Fluid 500 on customer search, a
 * missing private key. Those become the same neutral 200 here, through the
 * route's `onInvalidBody` / `onHandlerError` hooks.
 *
 * This function therefore does not throw for anything it can name. What it does
 * throw for is handled one level up, and answers the same body.
 */

import { createFluidClient, FluidError } from "@/lib/fluid";
import { fluidApiSettings } from "@/lib/settings";
import { createConsumer } from "@/lib/bydesign";
import {
  checkUserExists,
  createUPaymentsOrder,
  generateConsumerPayload,
  generateOrderPayload,
  onboardConsumer,
  present,
  type Cart,
  type RedirectCartPaymentRequest,
} from "@/lib/upayments";

export interface RedirectResult {
  redirect_url: string | null;
  error_message?: string;
}

/**
 * The single body this leg answers with when it cannot produce a URL.
 *
 * Deliberately one constant. Per the shared brief it must be byte-identical
 * across an auth failure, an unparseable body and a handler error, so the route
 * is not an oracle telling a caller which of the three they hit.
 */
export const NEUTRAL_RESULT: RedirectResult = {
  redirect_url: null,
  error_message: "We could not start the payment. Please try again.",
};

function refuse(message: string): RedirectResult {
  return { redirect_url: null, error_message: message };
}

/** `C` for a customer, `R` for a rep. Rails: `upayments_prefixed_external_id`. */
function prefixedExternalId(
  request: RedirectCartPaymentRequest,
): string | undefined {
  const customerId = request.customer?.external_id;
  if (present(customerId)) return `C${customerId}`;

  const repId = request.user_company?.external_id;
  if (present(repId)) return `R${repId}`;

  return undefined;
}

/** The unprefixed id, which is what Fluid stores. Rails: `raw_external_id`. */
function rawExternalId(
  request: RedirectCartPaymentRequest,
): string | undefined {
  const customerId = request.customer?.external_id;
  if (present(customerId)) return String(customerId);

  const repId = request.user_company?.external_id;
  if (present(repId)) return String(repId);

  return undefined;
}

/** Rails: `upayments_prefix_for`. */
function prefixFor(
  request: RedirectCartPaymentRequest,
  fluidExternalId: string | undefined,
): string | undefined {
  if (!present(fluidExternalId)) return fluidExternalId;
  const value = String(fluidExternalId);
  if (value.startsWith("C") || value.startsWith("R")) return value;
  return present(request.user_company) ? `R${value}` : `C${value}`;
}

/** The `POST /api/customers` body. Rails: `customer_payload`. */
function fluidCustomerPayload(cart: Cart): Record<string, unknown> {
  const shipTo = cart.ship_to ?? {};
  return {
    first_name: shipTo.first_name ?? null,
    last_name: shipTo.last_name ?? null,
    email: cart.email ?? null,
    notes: "Created by NewULife Payment Redirect Droplet",
    default_address_attributes: {
      address1: shipTo.address1 ?? null,
      address2: shipTo.address2 ?? null,
      city: shipTo.city ?? null,
      state: shipTo.state ?? null,
      postal_code: shipTo.postal_code ?? null,
      country_code: shipTo.country_code ?? null,
      default: true,
    },
    customer_notes_attributes: [
      { note: "Created by NewULife Payment Redirect Droplet" },
    ],
  };
}

/**
 * "Paying on behalf of someone else" — the payer's wallet, not the shopper's.
 *
 * Both metadata fields have to be present; Rails required both, and half of the
 * pair would mean charging the wrong wallet.
 */
function payerMetadata(cart: Cart) {
  const metadata = cart.metadata ?? {};
  const walletUuid = metadata.payer_wallet_uuid;
  const externalId = metadata.external_id;
  return present(walletUuid) && present(externalId)
    ? { walletUuid: String(walletUuid), externalId: String(externalId) }
    : null;
}

export async function getRedirectUrl(
  request: RedirectCartPaymentRequest,
  signal?: AbortSignal,
): Promise<RedirectResult> {
  const cart = request.cart;
  const paymentAccountId = String(request.payment_account_id);
  const onBehalfOf = payerMetadata(cart);

  let upaymentsExternalId = prefixedExternalId(request);
  let fluidExternalId = rawExternalId(request);

  // `user` is the object the shopper's wallet uuid is eventually read from. It
  // starts as the lookup response and is replaced by the onboarding response
  // when a consumer is created — exactly as the Ruby's reassignment did.
  let user = await checkUserExists({
    email: cart.email ?? undefined,
    externalId: upaymentsExternalId,
    signal,
  });

  // `status == 0` means "no such uPayments user". Ruby wrote `&.zero?`, so a
  // missing status is NOT zero and does not enter this branch.
  if (user.status === 0) {
    const sponsorRepId = present(request.attribution?.external_id)
      ? String(request.attribution?.external_id)
      : "1";

    // IRREVERSIBLE. Called unconditionally, exactly as Rails does, so a
    // retried callback for the same cart creates a second ByDesign consumer.
    // Preserved rather than "fixed": deduplicating would need a ByDesign lookup
    // this droplet has never made, and guessing at one on the money path is
    // worse than the known behaviour.
    const consumer = await createConsumer({ cart, sponsorRepId, signal });
    const consumerCreated = consumer.Result?.IsSuccessful === true;
    const byDesignCustomerId = consumer.CustomerID;

    const { api_key, base_url } = await fluidApiSettings();
    const fluid = createFluidClient(api_key, base_url);

    // Wrapped, unlike the Ruby: `FluidClient#handle_response` raises on any
    // non-2xx and this GET was the one call in the method with no rescue, so a
    // Fluid 500 on customer search became an HTTP 500 on a checkout-blocking
    // callback. Same file, same method, the POST two lines below WAS guarded —
    // an oversight rather than a decision.
    let existingCustomers: Array<Record<string, unknown>> = [];
    try {
      const found = await fluid.searchCustomers(cart.email ?? "");
      existingCustomers = found.customers ?? [];
    } catch (error) {
      console.error(
        "[RedirectCartPayment] Fluid customer search failed:",
        error instanceof Error ? error.message : error,
      );
      return refuse("We could not look up your account. Please try again.");
    }

    if (existingCustomers.length > 0) {
      fluidExternalId = existingCustomers[0].external_id as string | undefined;
      upaymentsExternalId = prefixFor(request, fluidExternalId);
    } else if (consumerCreated && present(byDesignCustomerId)) {
      fluidExternalId = String(byDesignCustomerId);
      upaymentsExternalId = `C${fluidExternalId}`;
      try {
        // IRREVERSIBLE.
        await fluid.createCustomer({
          ...fluidCustomerPayload(cart),
          external_id: fluidExternalId,
        });
      } catch (error) {
        if (!(error instanceof FluidError)) throw error;
        console.error(
          `[RedirectCartPayment] Fluid customer creation failed for external_id=${fluidExternalId}`,
        );
        return refuse("Failed to create customer in Fluid");
      }
    } else {
      const message =
        consumer.Result?.Message || "Failed to create customer in ByDesign";
      console.error(
        "[RedirectCartPayment] ByDesign customer creation failed and no existing Fluid customer",
      );
      return refuse(message);
    }

    // Skipped when someone else is paying: the payer already has a wallet.
    if (!onBehalfOf) {
      const onboarded = await onboardConsumer({
        payload: generateConsumerPayload({
          cart,
          externalId: upaymentsExternalId,
        }),
        signal,
      });

      if (onboarded.status === 0) {
        return refuse(
          onboarded.error?.message ?? NEUTRAL_RESULT.error_message!,
        );
      }
      user = onboarded;
    }
  }

  let loginUuid: string | undefined;
  let payerExternalId: string | undefined;

  if (onBehalfOf) {
    loginUuid = onBehalfOf.walletUuid;
    payerExternalId = onBehalfOf.externalId;

    const payerCheck = await checkUserExists({
      email: cart.email ?? undefined,
      externalId: payerExternalId,
      signal,
    });

    if (payerCheck.status === 0) {
      // The external id is logged; the wallet uuid is not — it is the value
      // that authorises the charge.
      console.error(
        `[RedirectCartPayment] Payer not found in uPayments: external_id=${payerExternalId}`,
      );
      return refuse("Payer account not found");
    }
  } else {
    loginUuid = (user.data?.uuid as string | undefined) ?? undefined;
    payerExternalId = upaymentsExternalId;
  }

  const orderPayload = generateOrderPayload({
    cart,
    externalId: payerExternalId,
    paymentAccountId,
    loginUuid,
    dropletHostUrl: (process.env.DROPLET_HOST_URL ?? "").replace(/\/$/, ""),
    checkoutHostUrl: (process.env.CHECKOUT_HOST_URL ?? "").replace(/\/$/, ""),
  });

  // The Ruby logged this whole payload, and the whole response, at info — the
  // shopper's address, email and order lines, on every checkout. Neither is
  // logged here.
  const orderResponse = await createUPaymentsOrder({
    payload: orderPayload,
    signal,
  });

  if (orderResponse.status === 0) {
    return refuse(
      orderResponse.error?.message ?? NEUTRAL_RESULT.error_message!,
    );
  }

  const redirectUrl = orderResponse.data?.redirectUrl;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) {
    // Fail closed in the business sense: a missing url is not a url to send a
    // shopper to. Rails would have rendered `{redirect_url: nil}`, which
    // satisfies the schema's `required: [redirect_url]` branch and tells the
    // shopper nothing at all.
    console.error(
      "[RedirectCartPayment] uPayments returned no redirectUrl on a non-zero status",
    );
    return NEUTRAL_RESULT;
  }

  return { redirect_url: redirectUrl };
}
