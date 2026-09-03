/**
 * Creating a consumer in ByDesign.
 *
 * Port of app/services/by_design.rb.
 *
 * IRREVERSIBLE from this droplet's side: there is no delete. It is called
 * unconditionally whenever the uPayments user lookup answers `status: 0`, so a
 * retried callback for the same cart creates a second consumer. That is the
 * Rails behaviour and it is preserved — the alternative would be to invent a
 * lookup this droplet has never made.
 *
 * ## What is NOT ported
 *
 * The Ruby logs the full request payload and the full response body at `info`
 * (by_design.rb:18, :27). Both carry the shopper's name, email and complete
 * shipping and billing address, into Cloud Logging, on every checkout. Nothing
 * here logs either.
 */

import { COUNTRY_CODE_MAP } from "./country-codes";
import type { Cart } from "@/lib/upayments/cart";

export interface ByDesignConsumerResult {
  Result: { IsSuccessful: boolean; Message?: string };
  CustomerID?: string | number;
  [key: string]: unknown;
}

/** Canadian postal codes arrive as "V9R 5G1"; ByDesign wants "V9R5G1". */
export function normalizePostalCode(
  postalCode: string | null | undefined,
): string | null {
  if (!postalCode) return postalCode ?? null;
  return String(postalCode).replace(/\s+/g, "");
}

/** ByDesign wants country NAMES, uppercase. */
export function mapCountryCode(
  countryCode: string | null | undefined,
): string | null {
  if (!countryCode) return countryCode ?? null;
  return COUNTRY_CODE_MAP[countryCode.toUpperCase()] ?? countryCode;
}

/**
 * The consumer body.
 *
 * `Password` is a fixed literal, shared by every consumer this droplet has ever
 * created, and it is published in this repository's history. Ported unchanged
 * because changing what is written into a live customer base is not a
 * migration's decision — but it is a live finding, tracked separately, and it
 * needs an answer from ByDesign about whether those accounts are reachable by
 * password login at all.
 */
export function generateConsumerPayload({
  cart,
  sponsorRepId,
}: {
  cart: Cart;
  sponsorRepId: string;
}): Record<string, unknown> {
  const shipTo = cart.ship_to ?? {};

  return {
    RepDID: sponsorRepId,
    FirstName: shipTo.first_name ?? null,
    LastName: shipTo.last_name ?? null,
    Email: cart.email ?? null,
    ShippingStreet1: shipTo.address1 ?? null,
    ShippingStreet2: shipTo.address2 ?? null,
    ShippingCity: shipTo.city ?? null,
    ShippingState: shipTo.state ?? null,
    ShippingPostalCode: normalizePostalCode(shipTo.postal_code),
    ShippingCountry: mapCountryCode(shipTo.country_code),
    BillingStreet1: shipTo.address1 ?? null,
    BillingStreet2: shipTo.address2 ?? null,
    BillingCity: shipTo.city ?? null,
    BillingState: shipTo.state ?? null,
    BillingPostalCode: normalizePostalCode(shipTo.postal_code),
    BillingCountry: mapCountryCode(shipTo.country_code),
    Password: "ByDesignTemporalPassword",
  };
}

export function byDesignAuthHeaders(): Record<string, string> {
  const username = process.env.BY_DESIGN_INTEGRATION_USERNAME ?? "";
  const password = process.env.BY_DESIGN_INTEGRATION_PASSWORD ?? "";
  const credentials = Buffer.from(`${username}:${password}`).toString("base64");

  return {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function byDesignBaseUrl(): string {
  return (process.env.BY_DESIGN_API_URL ?? "").replace(/\/$/, "");
}

/**
 * POST /api/users/customer.
 *
 * Returns the Rails-compatible envelope: a success is the parsed body merged
 * with `Result: { IsSuccessful: true }`, a failure is only that envelope with
 * `IsSuccessful: false` and a message. Callers read `Result.IsSuccessful` and
 * `CustomerID`, so the shape has to survive the port exactly.
 *
 * A 200 with an unparseable body raised in Ruby (`JSON.parse` with no rescue on
 * the success branch). Here it becomes an unsuccessful Result, because the
 * caller's own failure path — a 200 carrying `error_message` — is the right
 * shape for a checkout-blocking callback and a 500 is not.
 */
export async function createConsumer({
  cart,
  sponsorRepId,
  signal,
}: {
  cart: Cart;
  sponsorRepId: string;
  signal?: AbortSignal;
}): Promise<ByDesignConsumerResult> {
  const payload = generateConsumerPayload({ cart, sponsorRepId });

  const response = await fetch(`${byDesignBaseUrl()}/api/users/customer`, {
    method: "POST",
    headers: byDesignAuthHeaders(),
    body: JSON.stringify(payload),
    signal,
  });

  const text = await response.text();

  if (response.status !== 200) {
    const message = `ByDesign API error (${response.status})`;
    console.error(`[ByDesign] create_consumer failed: ${message}`);
    return { Result: { IsSuccessful: false, Message: message } };
  }

  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return { ...body, Result: { IsSuccessful: true } };
  } catch {
    console.error("[ByDesign] create_consumer returned a non-JSON 200");
    return {
      Result: {
        IsSuccessful: false,
        Message: "ByDesign returned an unreadable response",
      },
    };
  }
}
