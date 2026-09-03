/**
 * `order.external_id_synced` — attaching the ByDesign OrderID to the ledger.
 *
 * Port of app/jobs/fluid_order_external_id_updated_job.rb.
 *
 * This is the second of the two facts the recording run waits for. Fluid sends
 * it when the order has been synced to ByDesign and has an `external_id`; the
 * Moola webhook supplies the other half. Whichever arrives second is the one
 * that finds the row ready and drives the recording.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { runRecording } from "./bydesign-recording";
import {
  applyAndDetermineStatus,
  jsonObjectOf,
  shouldDriveRecording,
} from "./moola-payment";
import { isTerminal, statusName } from "./types";

export interface OrderSyncOutcome {
  handled: boolean;
  reason:
    | "processed"
    | "no_order_key"
    | "no_external_id"
    | "no_ledger_row"
    | "terminal_skipped";
  recordingRan?: boolean;
  /** See MoolaWebhookOutcome.recordingNeedsRetry — the caller raises so Fluid retries. */
  recordingNeedsRetry?: boolean;
}

export async function handleOrderExternalIdSynced(
  payload: unknown,
): Promise<OrderSyncOutcome> {
  const body = jsonObjectOf(payload);
  // Fluid sends `{ order: {...} }` and, enveloped, `{ payload: { order: {...} } }`.
  const orderData =
    (body.order as Record<string, unknown> | undefined) ??
    (jsonObjectOf(body.payload).order as Record<string, unknown> | undefined);

  if (!orderData) {
    console.warn(
      `[OrderExternalIdSynced] Unexpected payload structure - missing 'order'. ` +
        `Keys present: ${Object.keys(body).join(", ")}`,
    );
    return { handled: false, reason: "no_order_key" };
  }

  const cartToken =
    typeof orderData.cart_token === "string" ? orderData.cart_token : null;
  const externalId = orderData.external_id;
  const rawFluidOrderId = orderData.id ?? orderData.order_id;
  // `fluid_order_id` is a string column; normalise so the lookup matches.
  const fluidOrderId =
    rawFluidOrderId === null || rawFluidOrderId === undefined
      ? null
      : String(rawFluidOrderId);

  if (externalId === null || externalId === undefined || externalId === "") {
    console.log(
      "[OrderExternalIdSynced] No external_id yet; order is not in ByDesign",
    );
    return { handled: true, reason: "no_external_id" };
  }

  // cart_token first, fluid_order_id second — exactly as Rails did. Neither
  // column is unique except cart_token, so the second is a findFirst.
  const row = cartToken
    ? await prisma.moolaPayment.findUnique({ where: { cartToken } })
    : null;
  const found =
    row ??
    (fluidOrderId
      ? await prisma.moolaPayment.findFirst({ where: { fluidOrderId } })
      : null);

  if (!found) {
    console.warn(
      `[OrderExternalIdSynced] No ledger row for fluid_order_id=${fluidOrderId}. ` +
        "The checkout return may not have created it.",
    );
    return { handled: true, reason: "no_ledger_row" };
  }

  // THE TERMINAL GUARD, same invariant as the Moola webhook path. Added by
  // 6afa536: a late `order.external_id_synced` for an already-recorded cart
  // must not rewrite the stored payload the recording was built from.
  if (isTerminal(found.status)) {
    console.log(
      `[OrderExternalIdSynced] Skipping update for terminal payment: ` +
        `cart_token=${found.cartToken}, status=${statusName(found.status)}`,
    );
    return { handled: true, reason: "terminal_skipped" };
  }

  const updated = await applyAndDetermineStatus(found, {
    fluidOrderId,
    bydesignOrderId: String(externalId),
    fluidWebhookPayload: body as Prisma.InputJsonValue,
  });

  let recordingRan = false;
  let recordingNeedsRetry = false;
  if (shouldDriveRecording(updated)) {
    const outcome = await runRecording(updated.id);
    recordingRan = outcome.ran;
    recordingNeedsRetry = outcome.needsRetry;
  }

  console.log(
    `[OrderExternalIdSynced] Updated ${updated.cartToken}: ` +
      `status=${statusName(updated.status)}, recording_ran=${recordingRan}`,
  );

  return { handled: true, reason: "processed", recordingRan, recordingNeedsRetry };
}
