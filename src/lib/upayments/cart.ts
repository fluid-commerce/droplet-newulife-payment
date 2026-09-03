/**
 * The `redirect_cart_payment` request body.
 *
 * Shaped from two sources that have to agree: the definition's own schema at
 * app/lib/callback_definitions/redirect_cart_payment.yml in fluid (which
 * requires `cart` and `payment_account_id` and says nothing about the cart's
 * interior), and `CheckoutCallbackController#callback_params`, which is the
 * strong-parameters list the Rails code actually reads.
 *
 * Everything below `cart` is optional, because the definition does not
 * constrain it and a cart that is missing a field should produce a shopper-
 * facing `error_message`, not a parse failure that looks like an attack.
 */

import { z } from "zod";

const shipToSchema = z
  .object({
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    postal_code: z.string().nullish(),
    country_code: z.string().nullish(),
    email: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();

const itemSchema = z
  .object({
    product_title: z.string().nullish(),
    quantity: z.union([z.number(), z.string()]).nullish(),
    price: z.union([z.number(), z.string()]).nullish(),
    product: z.object({ sku: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const cartSchema = z
  .object({
    cart_token: z.string().nullish(),
    amount_total: z.union([z.number(), z.string()]).nullish(),
    tax_total: z.union([z.number(), z.string()]).nullish(),
    shipping_total: z.union([z.number(), z.string()]).nullish(),
    currency_code: z.string().nullish(),
    language_iso: z.string().nullish(),
    recurring: z.unknown().nullish(),
    email: z.string().nullish(),
    ship_to: shipToSchema.nullish(),
    items: z.array(itemSchema).nullish(),
    metadata: z
      .object({
        payer_wallet_uuid: z.string().nullish(),
        external_id: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const externalIdHolder = z
  .object({ external_id: z.union([z.string(), z.number()]).nullish() })
  .passthrough();

export const redirectCartPaymentSchema = z.object({
  cart: cartSchema,
  // The definition types this as a string. Real traffic has been observed
  // carrying `"223&status=SUCCESS"` — see extractPaymentAccountId — so it is
  // accepted as a number too rather than rejected.
  payment_account_id: z.union([z.string(), z.number()]),
  customer: externalIdHolder.nullish(),
  user_company: externalIdHolder.nullish(),
  attributable_rep_id: z.union([z.string(), z.number()]).nullish(),
  attribution: externalIdHolder
    .extend({
      name: z.string().nullish(),
      email: z.string().nullish(),
      share_guid: z.string().nullish(),
    })
    .nullish(),
});

export type RedirectCartPaymentRequest = z.infer<
  typeof redirectCartPaymentSchema
>;
export type Cart = z.infer<typeof cartSchema>;

/**
 * Ruby's `Object#present?`.
 *
 * Needed literally, not approximately: `autoshipRequired: cart[:recurring].present?`
 * is false for `false` and for `""`, and TRUE for the string `"false"`. A
 * JavaScript truthiness check agrees on the first two and disagrees on nothing
 * that matters here, but `[]` and `{}` are blank in Ruby and truthy in
 * JavaScript, and carts do carry empty collections.
 */
export function present(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Ruby's `format("%.2f", value)`.
 *
 * Ruby coerces a numeric string through `Float()`, so `"12.5"` formats as
 * `"12.50"`. A value that is not numeric at all raises in Ruby; here it becomes
 * `"0.00"`, which the two `conditional_*` helpers then drop from the payload
 * entirely — the same outcome as the field being absent, and better than a 500
 * on a checkout-blocking callback.
 */
export function money(value: unknown): string {
  const numeric = typeof value === "string" ? Number(value) : Number(value ?? 0);
  return (Number.isFinite(numeric) ? numeric : 0).toFixed(2);
}
