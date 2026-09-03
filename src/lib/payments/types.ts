/**
 * The ledger's vocabulary.
 *
 * Port of the constants and the ActiveRecord enum on app/models/moola_payment.rb.
 */

/**
 * `moola_payments.status`.
 *
 * An ActiveRecord enum stored as an integer, so the numbers ARE the data — the
 * on-disk values are 0..6 and a Prisma `enum` would have required a destructive
 * column type change on a live payments table. Keep the numbers.
 *
 * Rails: `enum :status, { pending: 0, matched: 1, recording: 2, recorded: 3,
 *                         failed: 4, kyc_pending: 5, kyc_declined: 6 }`
 */
export const MOOLA_PAYMENT_STATUS = {
  /** Waiting for both webhooks, or for KYC. */
  pending: 0,
  /** Both webhooks in and KYC approved. Ready to record. */
  matched: 1,
  /** Claimed by a recording run. */
  recording: 2,
  /** Every recordable line is in ByDesign. TERMINAL. */
  recorded: 3,
  /** Recording gave up after MAX_RECORDING_ATTEMPTS. TERMINAL. */
  failed: 4,
  /** KYC status is REVIEW. */
  kyc_pending: 5,
  /** KYC status is DECLINE. */
  kyc_declined: 6,
} as const;

export type MoolaPaymentStatusName = keyof typeof MOOLA_PAYMENT_STATUS;
export type MoolaPaymentStatus =
  (typeof MOOLA_PAYMENT_STATUS)[MoolaPaymentStatusName];

/** Reverse lookup, for log lines that should read like the Rails ones. */
export const MOOLA_PAYMENT_STATUS_NAME: Record<number, MoolaPaymentStatusName> =
  Object.fromEntries(
    Object.entries(MOOLA_PAYMENT_STATUS).map(([name, value]) => [value, name]),
  ) as Record<number, MoolaPaymentStatusName>;

export function statusName(status: number): string {
  return MOOLA_PAYMENT_STATUS_NAME[status] ?? `unknown(${status})`;
}

/**
 * THE IDEMPOTENCY INVARIANT.
 *
 * `recorded` and `failed` are terminal. Once a row reaches either, no inbound
 * webhook may change its attributes and nothing may move it back to a
 * re-runnable state.
 *
 * This is not a tidiness rule. It is the fix from commit 6fe8ea2 /
 * 6afa536 ("skip attribute overwrites on terminal payments in webhook jobs"),
 * and the bug it fixed was real money: `determineStatus` used to return
 * `matched` whenever the data looked complete, so a SECOND Moola delivery for
 * an already-recorded cart regressed `recorded` -> `matched`, sailed past the
 * enqueue guard, and recorded every payment to ByDesign a second time.
 *
 * Webhook delivery is at-least-once. The same payment event WILL arrive twice.
 *
 * Every caller that writes to a `moola_payments` row from webhook input must
 * consult this first. See `isTerminal` call sites, and
 * src/lib/payments/moola-payment.test.ts, which fails if this returns false for
 * a terminal status.
 */
export function isTerminal(status: number): boolean {
  return (
    status === MOOLA_PAYMENT_STATUS.recorded ||
    status === MOOLA_PAYMENT_STATUS.failed
  );
}

/** Rails: MoolaPayment::MAX_RECORDING_ATTEMPTS. */
export const MAX_RECORDING_ATTEMPTS = 5;

/** Rails: MoolaPayment::INVOICE_NUMBER_PREFIX. */
export const INVOICE_NUMBER_PREFIX = "NULF-CT";

/** One line of `moola_payments.payment_details`. */
export interface PaymentDetail {
  /** Stable per payment. Used as ByDesign's `ReferenceNumber` and as the receipt key. */
  id?: string;
  type?: string;
  amount?: string | number;
  status?: string;
  currency?: string;
  order_reference?: string;
  [key: string]: unknown;
}

/** `moola_payments.card_details`, enriched by the LOAD_FUNDS_VIA_CARD webhook. */
export interface CardDetails {
  card_number_last4?: string;
  last4?: string;
  expiry_date?: string;
  expiry_month?: string | number;
  expiry_year?: string | number;
  payment_instrument_uuid?: string;
  transaction_id?: string;
  parent_reference?: string;
  [key: string]: unknown;
}

/** Root-level fields of the Moola P2M webhook that ByDesign wants. */
export interface P2mData {
  order_reference?: string;
  client_uuid?: string;
  invoice_number?: string;
  autoship_reference?: string;
  completed_at?: string | number;
  from_account_name?: string;
}

export interface BillingAddress {
  name?: string;
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  subdivision_code?: string;
  country_code?: string;
  postal_code?: string;
}
