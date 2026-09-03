/**
 * The ledger row's own logic.
 *
 * Port of app/models/moola_payment.rb. Everything here is either a pure
 * function over a row's fields (so it can be tested without a database) or a
 * database claim (so it cannot be tested without one).
 */

import type { MoolaPayment, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  INVOICE_NUMBER_PREFIX,
  isTerminal,
  MAX_RECORDING_ATTEMPTS,
  MOOLA_PAYMENT_STATUS,
  statusName,
  type PaymentDetail,
} from "./types";

/** Rails: MoolaPayment.format_invoice_number. */
export function formatInvoiceNumber(cartToken: string): string {
  return `${INVOICE_NUMBER_PREFIX}:${cartToken}`;
}

/**
 * Rails: MoolaPayment.extract_cart_token.
 *
 * The `.+` is greedy and anchored at both ends in the Ruby original, so a cart
 * token containing a colon round-trips. Kept.
 */
export function extractCartToken(
  invoiceNumber: string | null | undefined,
): string | null {
  if (!invoiceNumber) return null;
  const match = new RegExp(`^${INVOICE_NUMBER_PREFIX}:(.+)$`).exec(
    invoiceNumber,
  );
  return match ? match[1] : null;
}

/** The subset of a row the pure predicates need. */
export interface LedgerState {
  status: number;
  kycStatus: string | null;
  bydesignOrderId: string | null;
  paymentDetails: PaymentDetail[];
}

export function paymentDetailsOf(
  row: Pick<MoolaPayment, "paymentDetails">,
): PaymentDetail[] {
  const value = row.paymentDetails;
  return Array.isArray(value) ? (value as PaymentDetail[]) : [];
}

export function cardDetailsOf(
  row: Pick<MoolaPayment, "cardDetails">,
): Record<string, unknown> {
  const value = row.cardDetails;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jsonObjectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function moolaDataPresent(state: LedgerState): boolean {
  return state.paymentDetails.length > 0;
}

export function kycApproved(state: LedgerState): boolean {
  return state.kycStatus === "APPROVE";
}

/**
 * Rails: MoolaPayment#determine_status.
 *
 * ## The terminal-state guard is the whole point of this function
 *
 * The first three lines are the fix from commit 6fe8ea2. Before it, a second
 * Moola delivery for a cart whose payments were already in ByDesign found
 * `payment_details` present, `bydesign_order_id` present and KYC approved, and
 * returned `matched` — regressing a TERMINAL `recorded` row into a re-runnable
 * one. `updateStatusAndEnqueueIfReady` then claimed it and recorded every line
 * to ByDesign a second time. Webhook delivery is at-least-once, so that second
 * delivery is not a hypothetical.
 *
 * `recording` is also preserved, for a different reason: a run is in flight and
 * a concurrent webhook must not describe the row as anything else.
 */
export function determineStatus(state: LedgerState): number {
  // Never regress from a terminal state — these payments are already in
  // ByDesign, or have been given up on. See isTerminal.
  if (isTerminal(state.status)) return state.status;

  // A recording run holds the row. Do not interfere.
  if (state.status === MOOLA_PAYMENT_STATUS.recording) {
    return MOOLA_PAYMENT_STATUS.recording;
  }

  if (state.kycStatus === "DECLINE") return MOOLA_PAYMENT_STATUS.kyc_declined;
  if (state.kycStatus === "REVIEW") return MOOLA_PAYMENT_STATUS.kyc_pending;

  if (
    moolaDataPresent(state) &&
    !!state.bydesignOrderId &&
    kycApproved(state)
  ) {
    return MOOLA_PAYMENT_STATUS.matched;
  }

  return MOOLA_PAYMENT_STATUS.pending;
}

/** Rails: MoolaPayment#ready_to_record?. */
export function readyToRecord(state: LedgerState): boolean {
  return (
    state.status === MOOLA_PAYMENT_STATUS.matched &&
    !!state.bydesignOrderId &&
    kycApproved(state) &&
    moolaDataPresent(state)
  );
}

/**
 * Rails: MoolaPayment#should_post_order?.
 *
 * Posting moves a ByDesign order from Entered to Posted and is irreversible, so
 * the three refusals are all deliberate: unapproved KYC, no payment lines at
 * all, and any cash line (which stays Entered until the cash is received).
 */
export function shouldPostOrder(state: LedgerState): boolean {
  if (state.kycStatus !== "APPROVE") return false;
  if (state.paymentDetails.length === 0) return false;
  if (state.paymentDetails.some((pd) => pd.type === "LOAD_FUNDS_VIA_CASH")) {
    return false;
  }
  return state.paymentDetails.every((pd) => pd.status === "Success");
}

export function maxAttemptsReached(attempts: number | null): boolean {
  return (attempts ?? 0) >= MAX_RECORDING_ATTEMPTS;
}

export function stateOf(row: MoolaPayment): LedgerState {
  return {
    status: row.status,
    kycStatus: row.kycStatus,
    bydesignOrderId: row.bydesignOrderId,
    paymentDetails: paymentDetailsOf(row),
  };
}

/**
 * How long a `recording` claim is honoured before another run may take it.
 *
 * There is no external queue in this app (see the note in
 * ./bydesign-recording.ts), so nothing retries a run whose process was killed
 * mid-flight — the row would sit in `recording` forever. Reclaiming it is only
 * safe because `bydesign_payment_receipts` makes each individual Save
 * idempotent; without that table this timeout would be a duplicate-payment
 * generator rather than a recovery.
 *
 * 15 minutes is comfortably longer than the worst case for one run: ByDesign
 * calls carry a 30s timeout and a cart has a handful of payment lines.
 */
export const STALE_RECORDING_CLAIM_MS = 15 * 60 * 1000;

export interface ClaimResult {
  claimed: boolean;
  reason:
    | "claimed"
    | "reclaimed_stale"
    | "not_found"
    | "terminal"
    | "in_progress"
    | "not_ready";
  row: MoolaPayment | null;
}

/**
 * Atomically claims a ledger row for a ByDesign recording run.
 *
 * Port of the Phase 2 half of `MoolaPayment#update_status_and_enqueue_if_ready!`
 * plus `ByDesignPaymentRecordingJob#claim_for_recording`, which in Rails were
 * two separate locks doing the same job.
 *
 * `SELECT ... FOR UPDATE` inside a transaction, exactly as the Ruby did
 * (`self.class.lock.find(id)`), and deliberately NOT an optimistic
 * `updateMany({ where: { status: matched } })`. The difference matters while
 * two runtimes can both reach this table: the row lock serialises them, an
 * optimistic update only narrows the window.
 *
 * The transaction contains one SELECT and one UPDATE and no network call, so it
 * is short by construction. The recording itself runs after it commits.
 */
export async function claimForRecording(
  id: bigint,
  now: Date = new Date(),
): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM moola_payments WHERE id = ${id} FOR UPDATE
    `;
    if (locked.length === 0) {
      return { claimed: false, reason: "not_found" as const, row: null };
    }

    // Read through the client so JSON columns and camelCase mapping apply. The
    // row lock taken above is held for the rest of the transaction.
    const row = await tx.moolaPayment.findUnique({ where: { id } });
    if (!row) {
      return { claimed: false, reason: "not_found" as const, row: null };
    }

    // Terminal rows are never re-claimed. This is the same invariant
    // determineStatus enforces, restated at the point where money would move.
    if (isTerminal(row.status)) {
      return { claimed: false, reason: "terminal" as const, row };
    }

    if (row.status === MOOLA_PAYMENT_STATUS.recording) {
      const heldFor = now.getTime() - row.updatedAt.getTime();
      if (heldFor < STALE_RECORDING_CLAIM_MS) {
        return { claimed: false, reason: "in_progress" as const, row };
      }
      const reclaimed = await tx.moolaPayment.update({
        where: { id },
        data: { status: MOOLA_PAYMENT_STATUS.recording },
      });
      return {
        claimed: true,
        reason: "reclaimed_stale" as const,
        row: reclaimed,
      };
    }

    if (!readyToRecord(stateOf(row))) {
      return { claimed: false, reason: "not_ready" as const, row };
    }

    const claimedRow = await tx.moolaPayment.update({
      where: { id },
      data: { status: MOOLA_PAYMENT_STATUS.recording },
    });
    return { claimed: true, reason: "claimed" as const, row: claimedRow };
  });
}

/**
 * Applies pending attribute changes, recomputes status, and reports whether the
 * row is now recordable.
 *
 * Port of `MoolaPayment#update_status_and_enqueue_if_ready!` phase 1. The Ruby
 * then enqueued a Solid Queue job; here the caller drives the recording itself,
 * so this returns the decision rather than acting on it.
 *
 * `patch` is applied to the IN-MEMORY row before `determineStatus` runs, which
 * is what the Ruby's `assign_attributes` + `determine_status` pair did. Callers
 * must have already checked `isTerminal` — this function will not overwrite a
 * terminal row's status, but it would happily overwrite its data.
 */
export async function applyAndDetermineStatus(
  row: MoolaPayment,
  patch: Prisma.MoolaPaymentUpdateInput & {
    kycStatus?: string | null;
    bydesignOrderId?: string | null;
  },
  merged: { paymentDetails?: PaymentDetail[] } = {},
): Promise<MoolaPayment> {
  const nextState: LedgerState = {
    status: row.status,
    kycStatus:
      patch.kycStatus !== undefined ? (patch.kycStatus ?? null) : row.kycStatus,
    bydesignOrderId:
      patch.bydesignOrderId !== undefined
        ? (patch.bydesignOrderId ?? null)
        : row.bydesignOrderId,
    paymentDetails: merged.paymentDetails ?? paymentDetailsOf(row),
  };

  const status = determineStatus(nextState);
  const becomingMatched =
    status === MOOLA_PAYMENT_STATUS.matched && row.matchedAt === null;

  return prisma.moolaPayment.update({
    where: { id: row.id },
    data: {
      ...patch,
      status,
      ...(becomingMatched ? { matchedAt: new Date() } : {}),
    },
  });
}

export function describeRow(row: MoolaPayment): string {
  return `cart_token=${row.cartToken}, status=${statusName(row.status)}`;
}
