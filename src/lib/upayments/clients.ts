/**
 * The two uPayments HTTP clients.
 *
 * Port of app/services/u_payments_user_api_client.rb and
 * app/services/u_payments_checkout_api_client.rb. They are separate classes in
 * Ruby because they use different base URLs and different signing keys, and
 * that separation is kept.
 *
 * ## What changed, and why
 *
 * The Ruby clients raise on a non-JSON body (`handle_response`) and raise in
 * `initialize` when a key or api code is missing. Both raises escape
 * `CheckoutCallbackController#get_redirect_url`, so a uPayments gateway error
 * page or a misconfigured deploy turns a checkout-blocking callback into an
 * HTTP 500. `redirect_cart_payment`'s response schema has no shape for that:
 * it is `anyOf: [required: [redirect_url], required: [error_message]]`, so a
 * 500 tells the shopper nothing and Fluid nothing useful.
 *
 * The throwing behaviour is kept here — a client that swallowed a gateway error
 * page and returned `{}` would be worse — but the ROUTE now catches it, through
 * the SDK's `onHandlerError` hook, and answers the same neutral 200 body as
 * every other failure. Same failure, correct shape.
 */

import { generateJwt, loadPrivateKey, requireEnv } from "./jwt";

/** The shape both APIs answer with. `status: 0` means "no"/failure. */
export interface UPaymentsResponse {
  status?: number;
  data?: Record<string, unknown>;
  error?: { message?: string };
  [key: string]: unknown;
}

interface ClientConfig {
  baseUrlEnv: string;
  privateKeyEnv: string;
  apiCodeEnv: string;
}

const USERS_API: ClientConfig = {
  baseUrlEnv: "UPAYMENTS_USERS_API_URL",
  privateKeyEnv: "NEWULIFE_PRIVATE_KEY",
  apiCodeEnv: "NEWULIFE_API_CODE",
};

const CHECKOUT_API: ClientConfig = {
  baseUrlEnv: "UPAYMENTS_CHECKOUT_API_URL",
  privateKeyEnv: "UPAYMENTS_MC_PRIVATE_KEY",
  apiCodeEnv: "UPAYMENTS_MC_API_CODE",
};

function authHeaders(config: ClientConfig): Record<string, string> {
  // Read per call rather than at module load. A module-scope read would bind
  // the value at import time, which in a Next route means at build time.
  const token = generateJwt({
    privateKey: loadPrivateKey(config.privateKeyEnv),
    apiCode: requireEnv(config.apiCodeEnv),
  });

  return {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function post(
  config: ClientConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<UPaymentsResponse> {
  const baseUrl = requireEnv(config.baseUrlEnv).replace(/\/$/, "");

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  try {
    return JSON.parse(text) as UPaymentsResponse;
  } catch {
    // Matches the Ruby `handle_response`, which raises on an unparseable body.
    // The body is NOT included: a uPayments error page can echo request data.
    throw new Error(
      `uPayments ${path} returned a non-JSON body (HTTP ${response.status})`,
    );
  }
}

/** POST /api/admin/customer — "does this consumer already exist?". */
export async function checkUserExists({
  email,
  externalId,
  signal,
}: {
  email: string | undefined;
  externalId: string | undefined;
  signal?: AbortSignal;
}): Promise<UPaymentsResponse> {
  // `"#{external_id}"` in Ruby, so a nil external_id was sent as "". Kept: the
  // API distinguishes "no such user" from a bad request on this field, and
  // sending `null` instead would change which one comes back.
  return post(
    USERS_API,
    "/api/admin/customer",
    { email, external_id: `${externalId ?? ""}` },
    signal,
  );
}

/** POST /login/on-board — creates the consumer in uPayments. */
export async function onboardConsumer({
  payload,
  signal,
}: {
  payload: unknown;
  signal?: AbortSignal;
}): Promise<UPaymentsResponse> {
  return post(USERS_API, "/login/on-board", payload, signal);
}

/**
 * POST /checkout/v2/order — opens a hosted-checkout order and returns the URL
 * the shopper is sent to.
 *
 * Semi-reversible: an unpaid order expires. Everything after it is not.
 */
export async function createUPaymentsOrder({
  payload,
  signal,
}: {
  payload: unknown;
  signal?: AbortSignal;
}): Promise<UPaymentsResponse> {
  return post(CHECKOUT_API, "/checkout/v2/order", payload, signal);
}
