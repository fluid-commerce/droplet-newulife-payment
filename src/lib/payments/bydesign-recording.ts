/**
 * Driving the ByDesign recording for one ledger row.
 *
 * Port of app/jobs/by_design_payment_recording_job.rb.
 *
 * ## There is no queue, and that is the design
 *
 * Rails ran this as a Solid Queue job. Solid Queue stores its jobs in the same
 * PostgreSQL database, and `WebhookEventJob#perform` wraps its work in a
 * transaction, so the `status -> :recording` write and the enqueue of the job
 * committed or rolled back together. That atomicity is real and easy to lose:
 * put the job in Redis or Cloud Tasks and the row can be marked `recording`
 * with no job ever enqueued (stuck forever), or the job enqueued and the row
 * rolled back (a run against a payment that was never matched).
 *
 * This app keeps the atomicity by removing the second thing entirely. There is
 * no enqueue. `claimForRecording` commits the claim, and whichever request
 * completed the preconditions then drives the run itself, inline. The row IS
 * the work item and `status` IS the claim, so there are no two things to keep
 * in step.
 *
 * The cost is that nothing retries a run whose process died mid-flight; the row
 * would hold `recording` forever. `claimForRecording` therefore reclaims a
 * claim older than STALE_RECORDING_CLAIM_MS — which is only safe because of the
 * receipts table below. Without it, that timeout would be a duplicate-payment
 * generator.
 *
 * ## The three duplicate-recording paths this closes
 *
 * All three exist in the Rails job today, and all three share one cause:
 * success was recorded per CART, not per PAYMENT.
 *
 *   (a) A raise on the `status: :recorded` write. `handle_error` set the status
 *       back to `:matched` and re-raised; `retry_on` ran the whole set again.
 *   (b) A raise while posting the order — which happens AFTER the `:recorded`
 *       write — landed in the same handler, regressing a terminal row.
 *   (c) Partial failure. Two payment lines, one Saved and one not:
 *       `handle_recording_failure` set the status back to `:matched`, and the
 *       next Moola re-delivery re-ran the set, re-Saving the line that landed.
 *
 * Here: (a) and (b) cannot regress a terminal row, because
 * `recordFailure` refuses to write over one. (b) additionally runs outside the
 * recording run's error envelope. And (c) cannot re-Save, because
 * `recordPaymentOnce` consults `bydesign_payment_receipts` first.
 */

import type { MoolaPayment } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { postOrder, recordPayment, shouldSkipPayment } from "@/lib/bydesign";
import {
  claimForRecording,
  jsonObjectOf,
  cardDetailsOf,
  maxAttemptsReached,
  paymentDetailsOf,
  shouldPostOrder,
  stateOf,
} from "./moola-payment";
import {
  isTerminal,
  MOOLA_PAYMENT_STATUS,
  statusName,
  type BillingAddress,
  type CardDetails,
  type P2mData,
  type PaymentDetail,
} from "./types";

export interface PaymentLineResult {
  paymentId: string | null;
  success: boolean;
  skipped?: boolean;
  alreadyRecorded?: boolean;
  error?: string | null;
  /**
   * Whether this payment reached ByDesign is UNKNOWN.
   *
   * Set when ByDesign never answered, and when a Save succeeded but its receipt
   * could not be written. Both leave the droplet unable to tell a recorded
   * payment from an unrecorded one, and there is no idempotency key to settle
   * it with. The run stops and the row goes terminal so a human looks — the
   * alternative is retrying an unknown up to MAX_RECORDING_ATTEMPTS times,
   * which is how one payment becomes five.
   */
  indeterminate?: boolean;
}

/** Rails: `build_p2m_data`. */
export function buildP2mData(row: MoolaPayment): P2mData {
  const payload = jsonObjectOf(row.moolaWebhookPayload);
  return {
    order_reference: payload.order_reference as string | undefined,
    client_uuid: payload.client_uuid as string | undefined,
    invoice_number: row.invoiceNumber,
    autoship_reference: payload.autoship_reference as string | undefined,
    completed_at: payload.completed_at as string | number | undefined,
    from_account_name: payload.from_account_name as string | undefined,
  };
}

/**
 * Rails: `build_billing_address`.
 *
 * The Fluid order's `ship_to` is used as the billing address, with
 * `shipping_address` as a fallback. That is what ByDesign is given today.
 */
export function buildBillingAddress(row: MoolaPayment): BillingAddress {
  const payload = jsonObjectOf(row.fluidWebhookPayload);
  const orderData = jsonObjectOf(payload.order ?? payload);
  const address = jsonObjectOf(
    orderData.ship_to ?? orderData.shipping_address ?? {},
  );

  return {
    name: address.name as string | undefined,
    first_name: (address.first_name ?? orderData.first_name) as
      | string
      | undefined,
    last_name: (address.last_name ?? orderData.last_name) as string | undefined,
    address1: address.address1 as string | undefined,
    address2: address.address2 as string | undefined,
    city: address.city as string | undefined,
    state: address.state as string | undefined,
    subdivision_code: address.subdivision_code as string | undefined,
    country_code: address.country_code as string | undefined,
    postal_code: address.postal_code as string | undefined,
  };
}

/**
 * Records ONE payment line to ByDesign, at most once ever.
 *
 * The receipt is the idempotency key this API does not offer.
 * `(bydesign_order_id, payment_detail_id)` is uniquely indexed, so:
 *
 *  - the SELECT short-circuits the ordinary re-run, and
 *  - the INSERT is the actual guard for two runs racing, because both can read
 *    "no receipt" and only one insert can win.
 *
 * The receipt is written AFTER a successful Save, so the failure mode is
 * "Saved but no receipt" — a re-run would then Save a second time. That
 * direction is chosen deliberately over "receipt then Save", whose failure mode
 * is a payment that is never recorded at all and that nothing will retry. A
 * lost payment is recoverable by an operator; a duplicate charge is not.
 *
 * A line without an `id` cannot be receipted, and is refused rather than
 * recorded unguarded.
 */
export async function recordPaymentOnce({
  row,
  payment,
  p2mData,
  cardDetails,
  billingAddress,
}: {
  row: MoolaPayment;
  payment: PaymentDetail;
  p2mData: P2mData;
  cardDetails: CardDetails;
  billingAddress: BillingAddress;
}): Promise<PaymentLineResult> {
  const paymentId = payment.id ?? null;
  const orderId = row.bydesignOrderId;

  if (!orderId) {
    return { paymentId, success: false, error: "No ByDesign order id" };
  }

  if (shouldSkipPayment(payment)) {
    return { paymentId, success: true, skipped: true };
  }

  if (!paymentId) {
    // Without a stable line id there is nothing to key a receipt on, so a retry
    // could not tell this line from a new one. Refuse rather than record
    // something that can silently double.
    return {
      paymentId: null,
      success: false,
      error: "Payment detail has no id; refusing to record unguarded",
    };
  }

  const existing = await prisma.bydesignPaymentReceipt.findUnique({
    where: {
      bydesignOrderId_paymentDetailId: {
        bydesignOrderId: orderId,
        paymentDetailId: paymentId,
      },
    },
  });

  if (existing) {
    console.log(
      `[Recording] Payment ${paymentId} already recorded for order ${orderId}; skipping`,
    );
    return { paymentId, success: true, alreadyRecorded: true };
  }

  const result = await recordPayment({
    orderId,
    payment,
    p2mData,
    cardDetails,
    billingAddress,
    kycStatus: row.kycStatus,
  });

  if (!result.success) {
    return {
      paymentId,
      success: false,
      error: result.error ?? "Unknown error",
      indeterminate: result.indeterminate,
    };
  }

  try {
    await prisma.bydesignPaymentReceipt.create({
      data: {
        bydesignOrderId: orderId,
        paymentDetailId: paymentId,
        cartToken: row.cartToken,
        recordedAt: new Date(),
        response: (result.response ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    // P2002 means a concurrent run inserted the receipt first — which means it
    // also made the Save. The money moved twice; nothing here can undo that,
    // so it is logged loudly rather than swallowed. The claim in
    // claimForRecording is what makes this unreachable in practice.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.error(
        `[Recording] DUPLICATE SAVE: receipt for payment ${paymentId} on order ` +
          `${orderId} already existed after a successful Save. Two runs held ` +
          "the row at once.",
      );
      return { paymentId, success: true, alreadyRecorded: true };
    }
    // Any other write failure leaves a Save with no receipt. Report the line as
    // failed so an operator sees it, and so the run does not mark the cart
    // recorded on the strength of a receipt that was not written.
    console.error(
      `[Recording] MANUAL CHECK REQUIRED: payment ${paymentId} was saved to ` +
        `ByDesign order ${orderId} but the receipt could not be written. ` +
        "A retry would Save it again, so this run stops here.",
      error instanceof Error ? error.message : error,
    );
    return {
      paymentId,
      success: false,
      error: "Payment was saved to ByDesign but the receipt could not be written",
      indeterminate: true,
    };
  }

  return { paymentId, success: true };
}

/**
 * Posts the ByDesign order, in its own error envelope.
 *
 * Rails ran this inside the recording job's `rescue StandardError`, so a raise
 * here — most plausibly from the `order_posted_at` write — regressed an
 * ALREADY-RECORDED row back to `:matched` and re-ran the whole recording. It is
 * separated here, and it never touches `status`.
 *
 * `order_posted_at` is checked first so a re-entry cannot post twice.
 */
export async function postOrderIfEligible(row: MoolaPayment): Promise<void> {
  try {
    if (row.orderPostedAt) {
      console.log(
        `[Recording] Order ${row.bydesignOrderId} already posted; skipping`,
      );
      return;
    }

    if (!shouldPostOrder(stateOf(row))) {
      console.log(
        `[Recording] Order not eligible for posting: kyc=${row.kycStatus}`,
      );
      return;
    }

    if (!row.bydesignOrderId) return;

    const result = await postOrder({ orderId: row.bydesignOrderId });

    if (result.success) {
      await prisma.moolaPayment.update({
        where: { id: row.id },
        data: { orderPostedAt: new Date() },
      });
      console.log(`[Recording] Order ${row.bydesignOrderId} posted`);
    } else {
      console.error(
        `[Recording] Failed to post order ${row.bydesignOrderId}: ${result.error}`,
      );
    }
  } catch (error) {
    // Swallowed on purpose. The payments are already in ByDesign; an unposted
    // order is an operator problem, and letting this raise would put the
    // recording run back into its failure path with a terminal row.
    console.error(
      "[Recording] post_order raised:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Writes a recording failure without ever regressing a terminal row.
 *
 * This is Rails' `handle_recording_failure` and `handle_error` merged, with the
 * one change that matters: the row is re-read under a lock and left alone if it
 * has since become terminal. Rails wrote `status: :matched` unconditionally,
 * which is duplicate-recording paths (a) and (b).
 */
async function recordFailure(id: bigint, message: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM moola_payments WHERE id = ${id} FOR UPDATE`;
    const current = await tx.moolaPayment.findUnique({ where: { id } });
    if (!current) return false;

    if (isTerminal(current.status)) {
      console.warn(
        `[Recording] Refusing to move ${current.cartToken} out of ` +
          `${statusName(current.status)} after a failure: ${message}`,
      );
      // The error is still worth keeping; the status is not touched.
      await tx.moolaPayment.update({
        where: { id },
        data: { lastError: message },
      });
      return false;
    }

    const attempts = (current.bydesignRecordingAttempts ?? 0) + 1;
    const givingUp = maxAttemptsReached(attempts);

    await tx.moolaPayment.update({
      where: { id },
      data: {
        bydesignRecordingAttempts: attempts,
        lastError: message,
        status: givingUp
          ? MOOLA_PAYMENT_STATUS.failed
          : MOOLA_PAYMENT_STATUS.matched,
        // Release the recording claim: the row is back to `matched` (or
        // terminal) and the timestamp would otherwise describe a claim nobody
        // holds.
        recordingClaimedAt: null,
      },
    });

    // Retryable until the attempt budget runs out. That budget is Rails'
    // MAX_RECORDING_ATTEMPTS, now spent on webhook re-deliveries rather than on
    // ActiveJob retries.
    return !givingUp;
  });
}

/**
 * Moves a row straight to `failed` without spending its attempt budget.
 *
 * Used only for an outcome nobody knows. `failed` is terminal, so no webhook
 * re-delivery and no reclaim will touch it again — which is the point: a human
 * has to reconcile against ByDesign before anything else Saves against this
 * order.
 *
 * A terminal row is left alone, exactly as recordFailure leaves it alone.
 */
async function giveUp(id: bigint, message: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM moola_payments WHERE id = ${id} FOR UPDATE`;
    const current = await tx.moolaPayment.findUnique({ where: { id } });
    if (!current || isTerminal(current.status)) return;

    await tx.moolaPayment.update({
      where: { id },
      data: {
        status: MOOLA_PAYMENT_STATUS.failed,
        lastError: message,
        bydesignRecordingAttempts: (current.bydesignRecordingAttempts ?? 0) + 1,
        recordingClaimedAt: null,
      },
    });
  });
}

export interface RecordingOutcome {
  ran: boolean;
  reason: string;
  results: PaymentLineResult[];
  /**
   * The run did not finish and the row can still be retried.
   *
   * This app has no queue. Rails retried the recording job up to five times;
   * here the caller turns this into a 5xx so the WEBHOOK DELIVERY is the retry —
   * Moola and Fluid both re-send a non-2xx. Without it, a transient ByDesign
   * outage would leave the row `matched` forever with a 202 already sent, and
   * nothing would ever come back for it.
   *
   * False once the row is terminal (`failed` after MAX_RECORDING_ATTEMPTS, or
   * `recorded`), because re-delivering then achieves nothing.
   */
  needsRetry: boolean;
}

/**
 * Records every recordable payment line for one ledger row.
 *
 * Returns without acting when the row is not claimable — terminal, held by
 * another run, or not yet ready. Callers treat that as ordinary.
 */
export async function runRecording(id: bigint): Promise<RecordingOutcome> {
  const claim = await claimForRecording(id);

  if (!claim.claimed || !claim.row) {
    console.log(`[Recording] Not claimed (${claim.reason}) for payment ${id}`);
    // `in_progress` is the only not-claimed reason worth coming back for: another
    // run holds the row right now. Terminal, not-found and not-ready are all
    // settled answers.
    return {
      ran: false,
      reason: claim.reason,
      results: [],
      needsRetry: claim.reason === "in_progress",
    };
  }

  const row = claim.row;
  if (claim.reason === "reclaimed_stale") {
    console.warn(
      `[Recording] Reclaimed a stale recording claim for ${row.cartToken}. ` +
        "Receipts make the re-run safe; investigate why the previous run stopped.",
    );
  }

  const p2mData = buildP2mData(row);
  const billingAddress = buildBillingAddress(row);
  const cardDetails = cardDetailsOf(row) as CardDetails;

  const recordable = paymentDetailsOf(row).filter(
    (pd) => !shouldSkipPayment(pd),
  );

  if (recordable.length === 0) {
    console.log("[Recording] No recordable payments (all declined)");
    const recorded = await prisma.moolaPayment.update({
      where: { id },
      data: {
        status: MOOLA_PAYMENT_STATUS.recorded,
        recordedAt: new Date(),
      },
    });
    await postOrderIfEligible(recorded);
    return {
      ran: true,
      reason: "no_recordable_payments",
      results: [],
      needsRetry: false,
    };
  }

  const results: PaymentLineResult[] = [];
  try {
    // Sequential, not Promise.all. Two Saves in flight against the same
    // ByDesign order is not something this repository knows to be safe, and the
    // receipts table protects re-runs, not concurrency inside one run.
    for (const payment of recordable) {
      const lineResult = await recordPaymentOnce({
        row,
        payment,
        p2mData,
        cardDetails,
        billingAddress,
      });
      results.push(lineResult);

      // Heartbeat the claim. The lease is a fixed 15 minutes from when it was
      // taken, and each ByDesign call can burn 30s of it — so a cart with
      // enough payment lines could outlive its own lease and be reclaimed
      // underneath itself, putting two runs on the same lines with neither
      // one's receipts written yet. Refreshing per line makes the lease
      // measure "time since progress" rather than "time since start".
      await prisma.moolaPayment
        .update({ where: { id }, data: { recordingClaimedAt: new Date() } })
        .catch(() => {});

      // STOP on an unknown. Continuing would Save the remaining lines and then
      // report a failure the caller retries — re-Saving a line whose outcome
      // nobody knows.
      if (lineResult.indeterminate) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = await recordFailure(id, message);
    return { ran: true, reason: "threw", results, needsRetry: retryable };
  }

  if (!results.every((r) => r.success)) {
    const message = results
      .filter((r) => !r.success)
      .map((r) => `${r.paymentId}: ${r.error}`)
      .join("; ");

    // An unknown outcome is not retried. See PaymentLineResult.indeterminate.
    if (results.some((r) => r.indeterminate)) {
      console.error(
        `[Recording] MANUAL CHECK REQUIRED for ${row.cartToken}: ByDesign did ` +
          `not confirm a payment, so whether it was recorded is unknown. ` +
          `Giving up rather than retrying. ${message}`,
      );
      await giveUp(id, `INDETERMINATE: ${message}`);
      return {
        ran: true,
        reason: "indeterminate",
        results,
        needsRetry: false,
      };
    }

    console.error(`[Recording] Recording failed: ${message}`);
    const retryable = await recordFailure(id, message);
    return {
      ran: true,
      reason: "partial_failure",
      results,
      needsRetry: retryable,
    };
  }

  // Every line is receipted. This write is what makes the row terminal, and
  // nothing after it is allowed to move it back.
  let recorded: MoolaPayment;
  try {
    recorded = await prisma.moolaPayment.update({
      where: { id },
      data: {
        status: MOOLA_PAYMENT_STATUS.recorded,
        recordedAt: new Date(),
      },
    });
  } catch (error) {
    // Rails' path (a). The Saves landed; only the bookkeeping failed. The row
    // stays in `recording` until the stale-claim timeout, and the re-run is a
    // no-op against the receipts rather than a second set of Saves.
    console.error(
      `[Recording] Payments for ${row.cartToken} were recorded to ByDesign but ` +
        "the status write failed. Receipts are in place, so a re-run will not " +
        "duplicate them.",
      error instanceof Error ? error.message : error,
    );
    // The row is left in `recording`, so the stale-claim reclaim is what picks
    // it up. Retrying the delivery would only hit `in_progress` until then.
    return {
      ran: true,
      reason: "status_write_failed",
      results,
      needsRetry: false,
    };
  }

  console.log(`[Recording] Recorded all payments for ${row.cartToken}`);

  // Outside the run's failure handling entirely. Rails' path (b).
  await postOrderIfEligible(recorded);

  return { ran: true, reason: "recorded", results, needsRetry: false };
}
