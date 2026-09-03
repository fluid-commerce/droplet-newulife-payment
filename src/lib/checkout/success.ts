/**
 * Leg ② — the uPayments browser return.
 *
 * Port of `CheckoutCallbackController#success`.
 *
 * uPayments sends the shopper's BROWSER here after they pay, at the
 * `redirectUrl` baked into the order when it was created. It is not a callback
 * and not a webhook: it is a navigation, the response is a 302, and it shares
 * no secret with anybody.
 *
 * ## READ THIS BEFORE CUTTING THIS LEG OVER
 *
 * This route decides "was this cart paid for?" by reading `status` out of the
 * QUERY STRING. It never asks uPayments. The shopper sees that URL in their own
 * address bar, so anyone holding a `cart_token` can complete a checkout without
 * paying by requesting `?status=SUCCESS`.
 *
 * That is a live defect in the Rails app, it is tracked separately, and it is
 * NOT fixed here — fixing it means verifying the payment out of band, and the
 * only out-of-band authority this repository knows about is the Moola webhook
 * (leg ③), which routinely arrives AFTER the browser does. Making the shopper
 * wait for it would trade a forgery risk for a checkout outage, and that is not
 * a trade to make blind inside a migration. CUTOVER.md lists it as a hard
 * blocker on this leg.
 *
 * ## What IS fixed: replay
 *
 * Rails re-ran both irreversible Fluid calls on every load of this URL — a
 * refresh, a back-button, a second tab. `POST /api/v202506/payments/:id`
 * creates a payment record and `POST /api/carts/:token/checkout` creates an
 * ORDER, and whether Fluid refuses a second checkout of an already-checked-out
 * cart is not known here. So the cart is claimed first, in a short transaction,
 * and the claim is released only by recording the resulting `fluid_order_id`.
 *
 * A load that finds the cart already checked out is answered with the SAME
 * confirmation URL, from the stored checkout response. A load that finds a
 * claim in flight is sent back to the Fluid checkout page, which is where the
 * shopper wants to be anyway.
 */

import type { MoolaPayment, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { createFluidClient, FluidError } from "@/lib/fluid";
import { fluidApiSettings } from "@/lib/settings";
import {
  applyAndDetermineStatus,
  formatInvoiceNumber,
  jsonObjectOf,
  readyToRecord,
  runRecording,
  stateOf,
} from "@/lib/payments";

/**
 * How long a checkout claim is honoured.
 *
 * A claim is NEVER released on failure, only by success recording a
 * `fluid_order_id`. That is the safe direction: if the Fluid payment call
 * succeeded and the checkout call then failed, releasing the claim would let a
 * refresh create a second payment and a second order. A shopper who has to wait
 * this long is recoverable; a duplicate order is not.
 */
export const CHECKOUT_CLAIM_TTL_MS = 10 * 60 * 1000;

export type CheckoutClaim =
  | { kind: "claimed"; row: MoolaPayment }
  | { kind: "already_checked_out"; row: MoolaPayment; confirmationUrl: string | null }
  | { kind: "in_flight"; row: MoolaPayment };

/**
 * Rails: `extract_status`.
 *
 * The second branch is not defensive programming, it is a real shape seen in
 * production: uPayments has returned the shopper to
 * `.../payment_account/223&status=SUCCESS`, with the whole thing landing in one
 * path segment. Both spellings are read.
 */
export function extractStatus(
  queryStatus: string | null,
  paymentAccountIdParam: string | null,
): string | null {
  if (queryStatus) return queryStatus;
  if (paymentAccountIdParam?.includes("&status=")) {
    const match = /&status=([^&]+)/.exec(paymentAccountIdParam);
    if (match) return match[1];
  }
  return null;
}

/** Rails: `extract_payment_account_id`. */
export function extractPaymentAccountId(
  paymentAccountIdParam: string | null,
): string | null {
  if (!paymentAccountIdParam) return null;
  return paymentAccountIdParam.includes("&status=")
    ? paymentAccountIdParam.split("&status=")[0]
    : paymentAccountIdParam;
}

function confirmationUrlOf(row: MoolaPayment): string | null {
  const stored = jsonObjectOf(row.fluidWebhookPayload);
  const order = jsonObjectOf(stored.order);
  const url = order.order_confirmation_url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

async function findOrCreateRow(cartToken: string): Promise<MoolaPayment> {
  const existing = await prisma.moolaPayment.findUnique({
    where: { cartToken },
  });
  if (existing) return existing;

  try {
    return await prisma.moolaPayment.create({
      data: { cartToken, invoiceNumber: formatInvoiceNumber(cartToken) },
    });
  } catch {
    // A concurrent request won the unique index on cart_token. Re-read.
    const raced = await prisma.moolaPayment.findUnique({ where: { cartToken } });
    if (raced) return raced;
    throw new Error(`Could not create or find a ledger row for ${cartToken}`);
  }
}

/**
 * Takes the checkout claim, or reports why it could not be taken.
 *
 * The transaction holds a row lock and contains no network call, so it is short
 * by construction. The Fluid calls happen after it commits.
 */
export async function claimCheckout(
  cartToken: string,
  now: Date = new Date(),
): Promise<CheckoutClaim> {
  await findOrCreateRow(cartToken);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM moola_payments WHERE cart_token = ${cartToken} FOR UPDATE
    `;
    const row = await tx.moolaPayment.findUniqueOrThrow({
      where: { cartToken },
    });

    // The permanent marker. Once a Fluid order exists for this cart, this route
    // never calls Fluid again — it replays the confirmation URL.
    if (row.fluidOrderId) {
      return {
        kind: "already_checked_out" as const,
        row,
        confirmationUrl: confirmationUrlOf(row),
      };
    }

    if (
      row.checkoutClaimedAt &&
      now.getTime() - row.checkoutClaimedAt.getTime() < CHECKOUT_CLAIM_TTL_MS
    ) {
      return { kind: "in_flight" as const, row };
    }

    const claimed = await tx.moolaPayment.update({
      where: { id: row.id },
      data: { checkoutClaimedAt: now },
    });
    return { kind: "claimed" as const, row: claimed };
  });
}

/**
 * Records the Fluid order against the ledger row, and starts the recording run
 * if that was the last fact it was waiting for.
 *
 * Port of `ensure_moola_payment_link`. The row already exists by this point —
 * `claimCheckout` created it — so this is an update, not the Ruby's
 * create-or-update pair.
 *
 * `bydesign_order_id` is taken from the checkout response when Fluid already
 * knows it. That is the fallback path; the authority is the
 * `order.external_id_synced` webhook (leg ④).
 */
export async function linkFluidOrder(
  row: MoolaPayment,
  checkoutResponse: Record<string, unknown>,
): Promise<MoolaPayment> {
  const order = jsonObjectOf(checkoutResponse.order);
  const rawOrderId = order.id ?? order.order_id;
  const fluidOrderId =
    rawOrderId === null || rawOrderId === undefined ? null : String(rawOrderId);
  const externalId = order.external_id;
  const bydesignOrderId =
    externalId === null || externalId === undefined || externalId === ""
      ? null
      : String(externalId);

  if (!fluidOrderId) {
    // `fluid_order_id` is what makes the claim permanent — without it the claim
    // expires after CHECKOUT_CLAIM_TTL_MS and a reload could check out again.
    // Fluid has always returned `order.id` here; if it ever does not, this line
    // is the only warning before that window opens.
    console.error(
      `[CheckoutSuccess] Fluid checked out ${row.cartToken} but returned no ` +
        "order id. The replay guard expires with the claim.",
    );
  }

  const updated = await applyAndDetermineStatus(row, {
    fluidOrderId: fluidOrderId ?? row.fluidOrderId,
    bydesignOrderId: bydesignOrderId ?? row.bydesignOrderId,
    fluidWebhookPayload: checkoutResponse as Prisma.InputJsonValue,
  });

  if (readyToRecord(stateOf(updated))) {
    // The Moola webhook may already have landed. See the note at the top of
    // src/lib/payments/bydesign-recording.ts on why this runs here rather than
    // being enqueued.
    await runRecording(updated.id);
  }

  return updated;
}

export type CheckoutOutcome =
  | { kind: "confirmed"; url: string }
  | { kind: "back_to_checkout"; reason: string };

/**
 * Completes the checkout for a cart the shopper has (apparently) paid for.
 *
 * Returns where to send the browser. Every failure sends them back to the Fluid
 * checkout page, which is the one place they can do something about it.
 */
export async function completeCheckout({
  cartToken,
  paymentAccountId,
  status,
}: {
  cartToken: string;
  paymentAccountId: string | null;
  status: string | null;
}): Promise<CheckoutOutcome> {
  if (status !== "SUCCESS") {
    return { kind: "back_to_checkout", reason: `status=${status ?? "none"}` };
  }

  if (!paymentAccountId) {
    return { kind: "back_to_checkout", reason: "no payment_account_id" };
  }

  const claim = await claimCheckout(cartToken);

  if (claim.kind === "already_checked_out") {
    console.log(
      `[CheckoutSuccess] Cart ${cartToken} is already checked out; replaying the confirmation`,
    );
    return claim.confirmationUrl
      ? { kind: "confirmed", url: claim.confirmationUrl }
      : { kind: "back_to_checkout", reason: "already checked out, no stored url" };
  }

  if (claim.kind === "in_flight") {
    console.warn(
      `[CheckoutSuccess] Cart ${cartToken} is already being checked out; refusing to start a second one`,
    );
    return { kind: "back_to_checkout", reason: "checkout in flight" };
  }

  const { api_key, base_url } = await fluidApiSettings();
  const fluid = createFluidClient(api_key, base_url);

  try {
    // IRREVERSIBLE. Creates the payment record in Fluid for the money uPayments
    // has already taken.
    const payment = await fluid.createPayment(paymentAccountId, {
      cart_token: cartToken,
      payment_method: { integration_class: "Droplet", source: "droplet" },
    });

    const paymentUuid = payment.payment?.uuid;
    if (!paymentUuid) {
      // The claim is deliberately NOT released. Fluid may or may not have
      // created the payment; a retry that creates a second one is worse than a
      // shopper who has to come back.
      console.error(
        `[CheckoutSuccess] Fluid returned no payment uuid for cart ${cartToken}`,
      );
      return { kind: "back_to_checkout", reason: "no payment uuid" };
    }

    // IRREVERSIBLE. This is where the order comes into existence.
    const checkout = await fluid.checkoutCart(cartToken, paymentUuid);

    const linked = await linkFluidOrder(claim.row, checkout);
    const order = jsonObjectOf(checkout.order);
    const confirmationUrl = order.order_confirmation_url;

    if (typeof confirmationUrl === "string" && confirmationUrl.length > 0) {
      return { kind: "confirmed", url: confirmationUrl };
    }

    console.error(
      `[CheckoutSuccess] Checked out cart ${cartToken} (ledger row ${linked.id}) ` +
        "but Fluid returned no order_confirmation_url",
    );
    return { kind: "back_to_checkout", reason: "no confirmation url" };
  } catch (error) {
    // Same reasoning as above: the claim stays. If this was a timeout on the
    // checkout call, Fluid may hold an order this droplet never saw, and a
    // retry would make a second one.
    const message =
      error instanceof FluidError
        ? `Fluid API error ${error.status}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(
      `[CheckoutSuccess] Checkout failed for cart ${cartToken}: ${message}. ` +
        `The claim is held for ${CHECKOUT_CLAIM_TTL_MS / 60000} minutes so a ` +
        "refresh cannot start a second checkout.",
    );
    return { kind: "back_to_checkout", reason: "fluid error" };
  }
}
