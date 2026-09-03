/**
 * The two uPayments request bodies.
 *
 * Port of app/services/u_payments_order_payload_generator.rb and
 * app/services/u_payments_consumer_payload_generator.rb.
 *
 * Key order is kept identical to the Ruby hashes. That is not cosmetic while
 * both apps exist: it lets a captured production request be diffed against the
 * generated one field-for-field.
 */

import { formatInvoiceNumber } from "@/lib/payments/moola-payment";
import { money, present, type Cart } from "./cart";

/** Rails: UPaymentsConsumerPayloadGenerator::PRODUCT_IDS. */
export const PRODUCT_IDS: Record<string, string> = {
  // Canada uses the USD product; the entry exists just in case.
  CAD: "8d7106c8-3ec9-4e1f-9942-7ab04359b234",
  CNY: "a8c5a3ca-e5cc-46d8-97d9-8dbc7a391ba7",
  EUR: "f5c806e6-ad3e-44d6-b8c7-baf19aad0227",
  GBP: "ba5c93f9-fca6-4c06-babf-ffa41732b96b",
  HKD: "3285a071-8aed-4ab0-8164-e6877111153d",
  JPY: "a5a0d5bb-fc36-478b-bb7a-69997300fcc9",
  KRW: "48d534a0-9238-4da5-bf4c-4bed332ca4f3",
  MYR: "25a392df-ac72-4a6b-a59b-e300232288bc",
  SGD: "1fc7b689-1270-48f8-a0f5-19783787d183",
  THB: "97ee0547-2e65-43cf-a4b2-2cc25725edda",
  TWD: "565a6912-058b-444a-bbc7-6a8f34b62dd7",
  USD: "8d7106c8-3ec9-4e1f-9942-7ab04359b234",
};

export function generateConsumerPayload({
  cart,
  externalId,
}: {
  cart: Cart;
  externalId: string | undefined;
}): Record<string, unknown> {
  const shipTo = cart.ship_to ?? {};

  return {
    first_name: shipTo.first_name ?? null,
    last_name: shipTo.last_name ?? null,
    email: cart.email ?? null,
    phone: null,
    product_uuid: cart.currency_code
      ? (PRODUCT_IDS[cart.currency_code] ?? null)
      : null,
    dob: null,
    address1: shipTo.address1 ?? null,
    address2: shipTo.address2 ?? null,
    city: shipTo.city ?? null,
    state: shipTo.state ?? null,
    zipcode: shipTo.postal_code ?? null,
    // Both of these are hardcoded in the Ruby, with a TODO. Ported as-is:
    // changing what is sent to a payment processor is not a migration's job.
    country_code: "+1",
    ssn: null,
    primaryWallet: cart.currency_code ?? null,
    business_name: null,
    external_id: externalId ?? null,
    hkcm: false,
  };
}

export function generateOrderPayload({
  cart,
  externalId,
  paymentAccountId,
  loginUuid,
  dropletHostUrl,
  checkoutHostUrl,
  now = Math.floor(Date.now() / 1000),
}: {
  cart: Cart;
  externalId: string | undefined;
  paymentAccountId: string;
  loginUuid: string | undefined;
  dropletHostUrl: string;
  checkoutHostUrl: string;
  now?: number;
}): Record<string, unknown> {
  const shipTo = cart.ship_to ?? {};
  const cartToken = cart.cart_token ?? "";

  // Rails emitted `salesTax` / `exciseTax` only when the value was present AND
  // did not format to "0.00". Both conditions kept: uPayments treats a present
  // zero differently from an absent field.
  const salesTax = present(cart.tax_total) ? money(cart.tax_total) : null;
  const shipping = present(cart.shipping_total)
    ? money(cart.shipping_total)
    : null;

  return {
    invoiceNumber: formatInvoiceNumber(cartToken),
    totalAmount: money(cart.amount_total),
    ...(salesTax && salesTax !== "0.00" ? { salesTax } : {}),
    // `exciseTax` really is where the shipping total goes — see
    // "feat: send shipping amount to UPayments as exciseTax" (03098eb).
    ...(shipping && shipping !== "0.00" ? { exciseTax: shipping } : {}),
    currency: cart.currency_code ?? null,
    // THE url uPayments sends the shopper back to. It is baked into every order
    // at creation time, so orders opened before a cutover keep pointing at
    // whichever host created them — see CUTOVER.md, which is why the Next app
    // serves this route at the same path Rails does.
    redirectUrl: `${dropletHostUrl}/checkout/success/${cartToken}/payment_account/${paymentAccountId}`,
    cancelUrl: `${checkoutHostUrl}/checkouts/${cartToken}`,
    orderTime: String(now),
    externalId: externalId ?? null,
    loginUuid: loginUuid ?? null,
    language: cart.language_iso ?? null,
    tipAllowed: false,
    autoshipRequired: present(cart.recurring),
    shippingInformation: {
      AddressLine1: shipTo.address1 ?? null,
      AddressLine2: shipTo.address2 ?? null,
      city: shipTo.city ?? null,
      country: shipTo.country_code ?? null,
      emailaddress: shipTo.email ?? null,
      recipientName: shipTo.name ?? null,
      postalCode: shipTo.postal_code ?? null,
      phoneNumber: null,
      state: shipTo.state ?? null,
    },
    // Ruby raised NoMethodError when `items` was absent, which surfaced as an
    // HTTP 500 on a checkout-blocking callback. An empty list is sent instead;
    // uPayments rejects it with a message the shopper can be shown.
    productDetails: (cart.items ?? []).map((item) => ({
      productId: item.product?.sku ?? null,
      description: item.product_title ?? null,
      quantity: item.quantity === null || item.quantity === undefined
        ? ""
        : String(item.quantity),
      unitPrice:
        item.price === null || item.price === undefined ? "" : String(item.price),
    })),
  };
}
