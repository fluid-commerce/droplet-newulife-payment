/**
 * Leg ② — where uPayments sends the shopper's browser after they pay.
 *
 * Port of `CheckoutCallbackController#success`, at THE SAME PATH:
 * `GET /checkout/success/:cart_token/payment_account/:payment_account_id`.
 *
 * The path is unchanged on purpose, and it is the one place in this migration
 * where that is load-bearing rather than convenient. `redirectUrl` is baked
 * into every uPayments order when the order is created, so every order that is
 * already open points at whichever host created it, for as long as it stays
 * payable. Keeping the path identical means the Rails app can forward to this
 * one with a plain 302 during the cutover window. See CUTOVER.md.
 *
 * Read the module docstring of src/lib/checkout/success.ts before touching
 * this: the route still trusts a query-string `status`, that is a live defect,
 * and it is a hard blocker on cutting this leg over.
 */

import { NextResponse } from "next/server";

import {
  completeCheckout,
  extractPaymentAccountId,
  extractStatus,
} from "@/lib/checkout";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ cartToken: string; paymentAccountId: string }>;
  },
): Promise<Response> {
  const { cartToken, paymentAccountId: rawPaymentAccountId } = await params;
  const url = new URL(request.url);

  // Both are read the Rails way. `payment_account_id` has been observed
  // arriving as `223&status=SUCCESS` in a single path segment, so the status
  // can hide inside it.
  const status = extractStatus(
    url.searchParams.get("status"),
    rawPaymentAccountId,
  );
  const paymentAccountId = extractPaymentAccountId(rawPaymentAccountId);

  const checkoutHostUrl = (process.env.CHECKOUT_HOST_URL ?? "").replace(
    /\/$/,
    "",
  );
  const backToCheckout = `${checkoutHostUrl}/checkouts/${cartToken}`;

  try {
    const outcome = await completeCheckout({
      cartToken,
      paymentAccountId,
      status,
    });

    return NextResponse.redirect(
      outcome.kind === "confirmed" ? outcome.url : backToCheckout,
      { status: 302 },
    );
  } catch (error) {
    // A shopper who has paid must never see a stack trace or a 500. Send them
    // back to checkout, where they can see the state of their cart.
    console.error(
      `[CheckoutSuccess] Unhandled failure for cart ${cartToken}:`,
      error instanceof Error ? error.message : error,
    );
    return NextResponse.redirect(backToCheckout, { status: 302 });
  }
}
