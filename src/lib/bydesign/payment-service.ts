/**
 * Recording a payment against a ByDesign order, and posting that order.
 *
 * Port of app/services/by_design_payment_service.rb.
 *
 * Both calls are IRREVERSIBLE and neither accepts an idempotency key. The
 * payload building is pure and separated from the HTTP so it can be asserted
 * field-by-field against what the Ruby produces for the same input.
 */

import {
  byDesignAuthHeaders,
  byDesignBaseUrl,
  mapCountryCode,
} from "./consumer";
import type {
  BillingAddress,
  CardDetails,
  P2mData,
  PaymentDetail,
} from "@/lib/payments/types";

/** Rails: DEFAULT_TIMEOUT, in seconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export const CARD_PAYMENT_TYPE = "LOAD_FUNDS_VIA_CARD";
export const CASH_PAYMENT_TYPE = "LOAD_FUNDS_VIA_CASH";

/** Every Moola/uPayments type uses the same ByDesign account. */
export const DEFAULT_CREDIT_CARD_ACCOUNT_ID = 30;

/**
 * Webhook type -> the value ByDesign stores.
 *
 * Only one special case: ByDesign's Freedom reporting maps "p2m" to the
 * "UWallet" label, so "uwallet" is sent as "p2m". Everything else passes
 * through lowercased.
 *
 * The field this lands in is `ProcessorSpecificDetail3`. There is deliberately
 * NO `ProcessorSpecificDetail23` — ByDesign maps Detail3 to detail23 in its own
 * database (offset by 20), so sending Detail23 was both redundant and not a
 * valid API field. Removed in 6fe8ea2; do not reintroduce it.
 */
export const DETAIL23_TYPE_MAP: Record<string, string> = {
  uwallet: "p2m",
};

/** Moola payment status -> ByDesign PaymentStatusTypeID. */
export const PAYMENT_STATUS_MAP: Record<string, number> = {
  Success: 1,
  Pending: 6,
  Declined: 18,
  Failed: 18,
};

/** KYC overrides the payment status. `APPROVE` means "use the payment status". */
export const KYC_STATUS_MAP: Record<string, number | null> = {
  APPROVE: null,
  REVIEW: 6,
  DECLINE: 18,
};

/** Pending, not Success. The safe default for a status nobody recognises. */
export const DEFAULT_PAYMENT_STATUS = 6;

export interface ByDesignCallResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  response?: Record<string, unknown> | null;
  error?: string | null;
  /**
   * ByDesign never answered, so whether the payment was recorded is UNKNOWN.
   *
   * A read timeout is not the same failure as a 400. ByDesign may have
   * committed the Save and lost the response — there is no idempotency key to
   * settle it with, and no lookup this repository knows about. Retrying an
   * unknown is how one payment becomes five.
   *
   * The caller stops and hands the row to an operator instead. A definite
   * failure (ByDesign answered, and said no) stays retryable.
   */
  indeterminate?: boolean;
}

export function shouldSkipPayment(payment: PaymentDetail): boolean {
  return payment.status === "Declined";
}

export function isCardPayment(type: string | undefined): boolean {
  return type === CARD_PAYMENT_TYPE;
}

export function isCashPayment(type: string | undefined): boolean {
  return type === CASH_PAYMENT_TYPE;
}

export function normalizePaymentType(
  paymentType: string | undefined,
): string | null {
  if (!paymentType) return null;
  const lowered = paymentType.toLowerCase();
  return DETAIL23_TYPE_MAP[lowered] ?? lowered;
}

/**
 * The effective ByDesign status for one payment line.
 *
 * Priority, straight from the Ruby:
 *   1. KYC status, when it maps to something (REVIEW/DECLINE)
 *   2. cash is always Pending, whatever the line says
 *   3. the line's own status
 *   4. Pending
 *
 * Note the Ruby used `kyc_override.present?`, so the `APPROVE -> nil` entry
 * falls through — and so would a `0`, which is not a status this map contains.
 */
export function determineEffectiveStatus(
  payment: PaymentDetail,
  kycStatus: string | null | undefined,
): number {
  const kycOverride = kycStatus ? KYC_STATUS_MAP[kycStatus] : undefined;
  if (kycOverride !== null && kycOverride !== undefined) return kycOverride;

  if (isCashPayment(payment.type)) return 6;

  const status = payment.status;
  if (status && status in PAYMENT_STATUS_MAP) return PAYMENT_STATUS_MAP[status];

  return DEFAULT_PAYMENT_STATUS;
}

function amountOf(payment: PaymentDetail): number {
  const value = Number(payment.amount ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** Pending money goes in PromissoryAmount and Amount is 0, and vice versa. */
export function calculateAmount(
  payment: PaymentDetail,
  kycStatus: string | null | undefined,
): number {
  return determineEffectiveStatus(payment, kycStatus) === 6
    ? 0
    : amountOf(payment);
}

export function calculatePromissoryAmount(
  payment: PaymentDetail,
  kycStatus: string | null | undefined,
): number {
  return determineEffectiveStatus(payment, kycStatus) === 6
    ? amountOf(payment)
    : 0;
}

/**
 * `PaymentDate`, byte-identical to what the Ruby emits.
 *
 * `completed_at` is milliseconds since the epoch, as a string.
 *
 * Two differences from a naive `toISOString()`, both measured against Ruby
 * rather than assumed:
 *
 *   Ruby  `Time.at(1767187441840 / 1000).iso8601` -> "2025-12-31T13:24:01+00:00"
 *   JS    `new Date(1767187441 * 1000).toISOString()` -> "2025-12-31T13:24:01.000Z"
 *
 * So the milliseconds are dropped AND `Z` is written as `+00:00`. Neither is
 * cosmetic: this is a field a payment processor parses, on every Save, and a
 * migration has no business changing it.
 *
 * The `+00:00` assumes the container runs in UTC. It does — neither
 * docker/Dockerfile nor config/ sets TZ, so the base image's UTC applies, and
 * `Time.at` renders in the SYSTEM zone (not `config.time_zone`). If that ever
 * stops being true, the Rails app's own output moves with it and this has to
 * follow.
 */
export function paymentDate(
  p2mData: P2mData,
  now: Date = new Date(),
): string {
  const toRubyIso = (date: Date) =>
    date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

  const completedAt = p2mData.completed_at;
  if (completedAt !== undefined && completedAt !== null && completedAt !== "") {
    const millis = Number(completedAt);
    if (Number.isFinite(millis)) {
      // Integer-divided by 1000 first, exactly as the Ruby does, so the
      // sub-second part is dropped rather than rounded.
      const seconds = Math.trunc(millis / 1000);
      const date = new Date(seconds * 1000);
      if (!Number.isNaN(date.getTime())) return toRubyIso(date);
    }
  }
  return toRubyIso(now);
}

export function extractLast4(cardDetails: CardDetails): string | null {
  if (cardDetails.card_number_last4) return String(cardDetails.card_number_last4);
  if (cardDetails.last4) return String(cardDetails.last4);
  return null;
}

function formatExpiry(
  month: string | number,
  year: string | number,
): string {
  const mm = String(month).padStart(2, "0");
  const yy = String(year).slice(-2);
  return `${mm}${yy}`;
}

/** "8/2029" -> "0829"; separate month/year fields are the fallback. */
export function extractExpiry(cardDetails: CardDetails): string | null {
  const expiryDate = cardDetails.expiry_date;
  if (expiryDate) {
    const parts = String(expiryDate).split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return formatExpiry(parts[0], parts[1]);
    }
  }

  const month = cardDetails.expiry_month;
  const year = cardDetails.expiry_year;
  if (month !== undefined && month !== null && month !== "" &&
      year !== undefined && year !== null && year !== "") {
    return formatExpiry(month, year);
  }

  return null;
}

/**
 * The `CreditCard/Save` body.
 *
 * `ReferenceNumber` is `payment_detail.id` — stable per payment line, and the
 * same value `bydesign_payment_receipts.payment_detail_id` is keyed on. Whether
 * ByDesign itself de-duplicates on it is unknown to this repository, which is
 * exactly why the receipts table exists.
 */
export function buildPaymentPayload({
  orderId,
  payment,
  p2mData = {},
  cardDetails = {},
  billingAddress = {},
  kycStatus,
  now,
}: {
  orderId: string | number;
  payment: PaymentDetail;
  p2mData?: P2mData;
  cardDetails?: CardDetails;
  billingAddress?: BillingAddress;
  kycStatus?: string | null;
  now?: Date;
}): Record<string, unknown> {
  const orderReference = payment.order_reference || p2mData.order_reference;
  const clientUuid = p2mData.client_uuid;

  const payload: Record<string, unknown> = {
    OrderID: Number.parseInt(String(orderId), 10),
    Amount: calculateAmount(payment, kycStatus),
    PromissoryAmount: calculatePromissoryAmount(payment, kycStatus),
    PaymentStatusTypeID: determineEffectiveStatus(payment, kycStatus),
    CreditCardAccountId: DEFAULT_CREDIT_CARD_ACCOUNT_ID,
    PaymentDate: paymentDate(p2mData, now),

    TransactionID: orderReference ?? null,
    ReferenceNumber: payment.id ?? null,

    PersistentToken: clientUuid ?? null,
    ProfileIDUsedForProcessor: clientUuid ?? null,

    ProcessorSpecificDetail1: p2mData.invoice_number ?? null,
    ProcessorSpecificDetail2: p2mData.autoship_reference ?? null,
    ProcessorSpecificDetail3: normalizePaymentType(payment.type),
    ProcessorSpecificDetail4: orderReference ?? null,
  };

  // Billing address. ByDesign requires CardHolderName, Address1, City, State,
  // Country and PostalCode on every payment, card or not.
  const fullName = [billingAddress.first_name, billingAddress.last_name]
    .filter(Boolean)
    .join(" ");
  payload.CardHolderName =
    p2mData.from_account_name || billingAddress.name || fullName || null;
  payload.Address1 = billingAddress.address1 ?? null;
  if (billingAddress.address2) payload.Address2 = billingAddress.address2;
  payload.City = billingAddress.city ?? null;
  payload.State = billingAddress.state ?? billingAddress.subdivision_code ?? null;
  payload.Country = mapCountryCode(billingAddress.country_code);
  payload.PostalCode = billingAddress.postal_code ?? null;

  if (isCardPayment(payment.type)) {
    payload.PaymentToken = cardDetails.payment_instrument_uuid ?? null;
    payload.Last4CCNumber = extractLast4(cardDetails);
    payload.ExpirationDateMMYY = extractExpiry(cardDetails);
  }

  return payload;
}

function parseResponse(
  status: number,
  text: string,
): ByDesignCallResult {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Matches the Ruby `parse_json_safely`: an unreadable body is `{}`, so a
    // 2xx with garbage is reported as a failure rather than as a success.
    console.error("[ByDesignPaymentService] JSON parse error");
  }

  const result = (body.Result ?? {}) as Record<string, unknown>;

  if (status === 200 || status === 201) {
    if (body.IsSuccessful === true || result.ID) {
      return { success: true, response: body, error: null };
    }
    return {
      success: false,
      response: body,
      error: String(body.Message ?? result.Message ?? "Unknown error"),
    };
  }

  return {
    success: false,
    response: body,
    error: String(body.Message ?? `HTTP ${status}`),
  };
}

async function postWithTimeout(
  path: string,
  body: string | undefined,
): Promise<ByDesignCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${byDesignBaseUrl()}${path}`, {
      method: "POST",
      headers: byDesignAuthHeaders(),
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    return parseResponse(response.status, await response.text());
  } catch (error) {
    // The Ruby rescued StandardError here and returned `{success: false}`
    // rather than raising. Kept, and it is load-bearing: a raise would unwind
    // into the recording run's error handler, which is one of the paths that
    // used to put an already-recorded row back into a re-runnable state.
    const message = error instanceof Error ? error.message : String(error);
    // A timeout means the request WAS sent and no answer came back. The Ruby
    // rescued `Net::OpenTimeout, Net::ReadTimeout` separately and then treated
    // them the same as everything else; this port does not, because "we do not
    // know whether the money moved" is a different fact from "it did not".
    const timedOut =
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    console.error(
      `[ByDesignPaymentService] ${path} failed${timedOut ? " (NO ANSWER)" : ""}: ${message}`,
    );
    return {
      success: false,
      error: message,
      response: null,
      indeterminate: timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/Personal/Order/Payment/CreditCard/Save. IRREVERSIBLE.
 *
 * Callers must go through recordPaymentOnce (src/lib/payments/bydesign-recording.ts),
 * which checks and writes `bydesign_payment_receipts` around this call. Nothing
 * in this module deduplicates.
 */
export async function recordPayment(args: {
  orderId: string | number;
  payment: PaymentDetail;
  p2mData?: P2mData;
  cardDetails?: CardDetails;
  billingAddress?: BillingAddress;
  kycStatus?: string | null;
}): Promise<ByDesignCallResult> {
  if (shouldSkipPayment(args.payment)) {
    return {
      success: true,
      skipped: true,
      reason: "Payment declined at processor level",
    };
  }

  const payload = buildPaymentPayload(args);
  // Amount, type and KYC only. Never the payload: it carries the cardholder
  // name, the billing address and the card's last four.
  console.log(
    `[ByDesignPaymentService] Recording payment: OrderID=${args.orderId}, ` +
      `Type=${args.payment.type}, KYC=${args.kycStatus}`,
  );

  return postWithTimeout(
    "/api/Personal/Order/Payment/CreditCard/Save",
    JSON.stringify(payload),
  );
}

/**
 * POST /api/order/Order/{id}/Post. IRREVERSIBLE.
 *
 * Moves the order from Entered to Posted. Guarded by `shouldPostOrder` and by
 * `order_posted_at` being null; see postOrderIfEligible.
 */
export async function postOrder({
  orderId,
}: {
  orderId: string | number;
}): Promise<ByDesignCallResult> {
  console.log(`[ByDesignPaymentService] Posting order: OrderID=${orderId}`);
  return postWithTimeout(`/api/order/Order/${orderId}/Post`, undefined);
}
