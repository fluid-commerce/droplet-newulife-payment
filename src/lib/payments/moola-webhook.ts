/**
 * Processing a Moola P2M / card webhook into the ledger.
 *
 * Port of app/jobs/moola_p2m_webhook_job.rb.
 *
 * ## At-least-once delivery is the design constraint
 *
 * Moola re-sends. The same payment event WILL arrive twice, and the second
 * arrival is the one that has caused real duplicate charges here before. Three
 * separate mechanisms keep that safe, and all three are ported:
 *
 *  1. `find_or_create_by!(cart_token:)` over the UNIQUE index on
 *     `cart_token` — a redelivery finds the row rather than making a second.
 *  2. `mergePaymentDetails` keys lines by `payment_details[].id` and keeps the
 *     better status, so a redelivery merges rather than appends and a later
 *     "Pending" cannot overwrite an earlier "Success".
 *  3. The TERMINAL GUARD — a row that is already `recorded` or `failed` is not
 *     touched at all. This is the fix from 6afa536: without it, a redelivery
 *     rewrote `payment_details` on a row whose payments were already in
 *     ByDesign, so the stored ledger drifted from what was actually sent, and
 *     (before 6fe8ea2) the status regressed and the whole set was recorded
 *     again.
 */

import type { MoolaPayment } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { runRecording } from "./bydesign-recording";
import {
  applyAndDetermineStatus,
  cardDetailsOf,
  extractCartToken,
  formatInvoiceNumber,
  paymentDetailsOf,
  readyToRecord,
  stateOf,
} from "./moola-payment";
import { isTerminal, statusName, type PaymentDetail } from "./types";

export const TRANSACTION_TYPE_P2M = "p2m";
export const TRANSACTION_TYPE_CARD = "load_funds_via_card";

/**
 * Status precedence when merging two versions of the same payment line.
 *
 * LOWER number wins. Anything unrecognised sorts last, so an unknown status
 * never displaces a known one.
 */
export const STATUS_PRIORITY: Record<string, number> = {
  Success: 1,
  Pending: 2,
  Declined: 3,
  Failed: 3,
};

export function betterStatus(a: unknown, b: unknown): unknown {
  const pa = STATUS_PRIORITY[String(a)] ?? 99;
  const pb = STATUS_PRIORITY[String(b)] ?? 99;
  return pa <= pb ? a : b;
}

type MoolaWebhookPayload = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function invoiceNumberOf(payload: MoolaWebhookPayload) {
  return str(payload.invoice_number);
}

export function transactionTypeOf(payload: MoolaWebhookPayload) {
  return str(payload.transaction_type);
}

export function kycStatusOf(payload: MoolaWebhookPayload) {
  return str(payload.kycStatus) ?? str(payload.kyc_status);
}

export function rawPaymentDetails(payload: MoolaWebhookPayload): PaymentDetail[] {
  const value = payload.payment_details;
  return Array.isArray(value) ? (value as PaymentDetail[]) : [];
}

export function isValidTransaction(payload: MoolaWebhookPayload): boolean {
  if (payload.type !== "transaction") return false;
  const type = transactionTypeOf(payload);
  return type === TRANSACTION_TYPE_P2M || type === TRANSACTION_TYPE_CARD;
}

/**
 * Rails: `normalize_payment_details`.
 *
 * Declined lines are dropped entirely — they are not recorded to ByDesign and
 * keeping them would make `shouldPostOrder`'s "all Success" test unsatisfiable
 * forever.
 *
 * Ruby's `.compact` removed nil values, so a field the webhook omitted is
 * ABSENT from the stored line rather than present-and-null. That distinction
 * matters to `mergePaymentDetails`, which treats a blank incoming value as "do
 * not overwrite".
 */
export function normalizePaymentDetails(
  payload: MoolaWebhookPayload,
): PaymentDetail[] {
  return rawPaymentDetails(payload)
    .filter((pd) => pd.status !== "Declined")
    .map((pd) => {
      // Built as a loose record and cast once. PaymentDetail narrows its known
      // fields, and assigning `unknown` into one of them is a type error even
      // though the interface carries an index signature.
      const line: Record<string, unknown> = {};
      const fields = [
        "type",
        "amount",
        "id",
        "status",
        "currency",
        "order_reference",
      ] as const;
      for (const field of fields) {
        const value = pd[field];
        if (value !== null && value !== undefined) line[field] = value;
      }
      return line as PaymentDetail;
    });
}

/**
 * Rails: `merge_payment_details`.
 *
 * The Ruby is `incoming_pd.merge(existing_pd) { |key, incoming_val, existing_val| ... }`,
 * which is easy to misread: `a.merge(b)` starts from `a` and lets `b` win, so
 * WITHOUT the block the EXISTING value would win every field. The block then
 * overrides that per key — `status` takes the better of the two, and every
 * other field prefers the incoming value when it is present.
 *
 * Order is preserved: existing lines first, in their stored order, then any
 * genuinely new line appended. Ruby's `index_by` + `values` does the same.
 */
export function mergePaymentDetails(
  existing: PaymentDetail[],
  incoming: PaymentDetail[],
): PaymentDetail[] {
  if (existing.length === 0) return incoming;

  const merged = new Map<string, PaymentDetail>();
  for (const line of existing) merged.set(String(line.id), line);

  for (const incomingLine of incoming) {
    const key = String(incomingLine.id);
    const existingLine = merged.get(key);

    if (!existingLine) {
      merged.set(key, incomingLine);
      continue;
    }

    const result: Record<string, unknown> = { ...incomingLine };
    for (const [field, existingValue] of Object.entries(existingLine)) {
      if (!(field in incomingLine)) {
        result[field] = existingValue;
        continue;
      }
      const incomingValue = incomingLine[field];
      if (field === "status") {
        result[field] = betterStatus(incomingValue, existingValue);
      } else {
        const incomingPresent =
          incomingValue !== null &&
          incomingValue !== undefined &&
          incomingValue !== "";
        result[field] = incomingPresent ? incomingValue : existingValue;
      }
    }
    merged.set(key, result as PaymentDetail);
  }

  return Array.from(merged.values());
}

/** Rails: `extract_card_details`, `.compact`ed. */
export function extractCardDetails(
  payload: MoolaWebhookPayload,
): Record<string, unknown> {
  const source: Record<string, unknown> = {
    card_number_last4: payload.card_number_last4,
    expiry_date: payload.expiry_date,
    payment_instrument_uuid: payload.payment_instrument_uuid,
    transaction_id: payload.id,
    parent_reference: payload.parent_reference,
  };

  return Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}

/**
 * Rails: `find_or_create_payment`.
 *
 * The `RecordNotUnique` rescue is the race between two concurrent deliveries
 * for a cart that has no row yet. Prisma raises P2002 for the same thing.
 */
async function findOrCreatePayment(
  cartToken: string,
  invoiceNumber: string,
): Promise<MoolaPayment> {
  const existing = await prisma.moolaPayment.findUnique({
    where: { cartToken },
  });
  if (existing) return existing;

  try {
    return await prisma.moolaPayment.create({
      data: { cartToken, invoiceNumber },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await prisma.moolaPayment.findUnique({
        where: { cartToken },
      });
      if (raced) return raced;
    }
    throw error;
  }
}

export interface MoolaWebhookOutcome {
  handled: boolean;
  reason:
    | "processed"
    | "unsupported_transaction_type"
    | "invalid_invoice_number"
    | "terminal_skipped"
    | "no_card_details";
  recordingRan?: boolean;
}

/**
 * Processes one Moola webhook body.
 *
 * Returns rather than throwing for every "nothing to do" case, because Moola
 * retries a non-2xx and re-delivering a payload this droplet has decided not to
 * act on achieves nothing.
 */
export async function processMoolaWebhook(
  payload: MoolaWebhookPayload,
): Promise<MoolaWebhookOutcome> {
  const transactionType = transactionTypeOf(payload);

  if (!isValidTransaction(payload)) {
    console.warn(
      `[MoolaWebhook] Skipping unsupported transaction type: ${transactionType}`,
    );
    return { handled: false, reason: "unsupported_transaction_type" };
  }

  const invoiceNumber = invoiceNumberOf(payload);
  const cartToken = extractCartToken(invoiceNumber);
  if (!cartToken) {
    // The invoice number is never logged: it embeds the cart token, which is
    // the bearer credential for the checkout-success route.
    console.error("[MoolaWebhook] Invalid invoice_number format");
    return { handled: false, reason: "invalid_invoice_number" };
  }

  const row = await findOrCreatePayment(
    cartToken,
    invoiceNumber ?? formatInvoiceNumber(cartToken),
  );

  // THE TERMINAL GUARD. Both branches below are guarded, exactly as 6afa536
  // guarded `update_payment_record` and `update_card_details`.
  //
  // A row that is `recorded` or `failed` has already had its payments sent to
  // ByDesign, or has been given up on. Rewriting `payment_details` from a
  // redelivery would make the stored ledger disagree with what was actually
  // sent — and before this guard existed, it also regressed the status and
  // recorded the whole set a second time.
  if (isTerminal(row.status)) {
    console.log(
      `[MoolaWebhook] Skipping update for terminal payment: ` +
        `cart_token=${row.cartToken}, status=${statusName(row.status)}`,
    );
    return { handled: true, reason: "terminal_skipped" };
  }

  const isCardWebhook = transactionType === TRANSACTION_TYPE_CARD;
  const updated = isCardWebhook
    ? await applyCardDetails(row, payload)
    : await applyPaymentRecord(row, payload);

  if (!updated) return { handled: true, reason: "no_card_details" };

  // Rails enqueued a Solid Queue job here. This app drives the run directly —
  // see the note at the top of ./bydesign-recording.ts.
  let recordingRan = false;
  if (readyToRecord(stateOf(updated))) {
    const outcome = await runRecording(updated.id);
    recordingRan = outcome.ran;
  }

  return { handled: true, reason: "processed", recordingRan };
}

/** Rails: `update_payment_record`, past the terminal guard. */
async function applyPaymentRecord(
  row: MoolaPayment,
  payload: MoolaWebhookPayload,
): Promise<MoolaPayment> {
  const mergedDetails = mergePaymentDetails(
    paymentDetailsOf(row),
    normalizePaymentDetails(payload),
  );

  return applyAndDetermineStatus(
    row,
    {
      moolaTransactionId:
        str(payload.transaction_id) ?? str(payload.id) ?? null,
      kycStatus: kycStatusOf(payload) ?? null,
      transactionType: transactionTypeOf(payload) ?? null,
      paymentDetails: mergedDetails as Prisma.InputJsonValue,
      moolaWebhookPayload: payload as Prisma.InputJsonValue,
    },
    { paymentDetails: mergedDetails },
  );
}

/** Rails: `update_card_details`, past the terminal guard. */
async function applyCardDetails(
  row: MoolaPayment,
  payload: MoolaWebhookPayload,
): Promise<MoolaPayment | null> {
  const cardDetails = extractCardDetails(payload);
  if (Object.keys(cardDetails).length === 0) return null;

  const kycStatus = kycStatusOf(payload);
  // Rails only filled KYC in from a card webhook when it was not already set —
  // the P2M webhook is the authority for it.
  const nextKyc = kycStatus && !row.kycStatus ? kycStatus : row.kycStatus;

  return applyAndDetermineStatus(row, {
    cardDetails: {
      ...cardDetailsOf(row),
      ...cardDetails,
    } as Prisma.InputJsonValue,
    kycStatus: nextKyc,
  });
}
