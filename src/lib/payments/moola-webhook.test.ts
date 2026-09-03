/**
 * Processing a Moola webhook into the ledger.
 *
 * The re-delivery tests are the point. Moola's delivery is at-least-once, and
 * every duplicate-charge incident this droplet has had started with a second
 * delivery of a payment it had already recorded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  moolaPayment: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

type RecordingOutcome = {
  ran: boolean;
  reason: string;
  results: unknown[];
  needsRetry: boolean;
};

const runRecordingMock = vi.hoisted(() =>
  vi.fn<(id: bigint) => Promise<RecordingOutcome>>(),
);

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("./bydesign-recording", () => ({ runRecording: runRecordingMock }));

const {
  betterStatus,
  extractCardDetails,
  isValidTransaction,
  mergePaymentDetails,
  normalizePaymentDetails,
  processMoolaWebhook,
} = await import("./moola-webhook");
const { MOOLA_PAYMENT_STATUS } = await import("./types");

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    cartToken: "cart_1",
    invoiceNumber: "NULF-CT:cart_1",
    fluidOrderId: null,
    bydesignOrderId: "12345",
    moolaTransactionId: null,
    kycStatus: "APPROVE",
    transactionType: null,
    paymentDetails: [],
    cardDetails: {},
    moolaWebhookPayload: {},
    fluidWebhookPayload: {},
    status: MOOLA_PAYMENT_STATUS.pending,
    bydesignRecordingAttempts: 0,
    lastError: null,
    matchedAt: null,
    recordedAt: null,
    orderPostedAt: null,
    checkoutClaimedAt: null,
    fluidPaymentUuid: null,
    recordingClaimedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const p2mBody = {
  type: "transaction",
  transaction_type: "p2m",
  invoice_number: "NULF-CT:cart_1",
  kycStatus: "APPROVE",
  transaction_id: "txn_1",
  payment_details: [
    {
      id: "EZC1236EQI",
      type: "uwallet",
      amount: "878.00",
      status: "Success",
      currency: "USD",
      order_reference: "TKW2BRL2OP",
    },
  ],
};

/**
 * Sets the row the code under test will read, and makes `update` return that
 * SAME row with the patch applied.
 *
 * Not a convenience: an update mock that rebuilds from the default fixture
 * silently resets every field the test set, so a test about `recording_claimed_at`
 * would assert against a row where it is null again.
 */
let current: ReturnType<typeof ledgerRow>;
function setLedgerRow(row: ReturnType<typeof ledgerRow>) {
  current = row;
  mockPrisma.moolaPayment.findUnique.mockResolvedValue(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  current = ledgerRow();
  runRecordingMock.mockResolvedValue({
    ran: true,
    reason: "recorded",
    results: [],
    needsRetry: false,
  });
  mockPrisma.moolaPayment.update.mockImplementation(
    async ({ where, data }: { where: { id: bigint }; data: object }) => ({
      ...current,
      id: where.id,
      ...data,
    }),
  );
});

describe("processMoolaWebhook — at-least-once delivery", () => {
  it("processes a first delivery and drives the recording once the row is ready", async () => {
    setLedgerRow(ledgerRow());

    const outcome = await processMoolaWebhook(p2mBody);

    expect(outcome).toMatchObject({ handled: true, reason: "processed" });
    expect(mockPrisma.moolaPayment.update).toHaveBeenCalledOnce();

    const written = mockPrisma.moolaPayment.update.mock.calls[0][0].data;
    // Both webhooks are in and KYC is approved, so the row is `matched` and the
    // recording runs. Without this assertion the terminal-guard tests below
    // would pass against a function that never does anything.
    expect(written.status).toBe(MOOLA_PAYMENT_STATUS.matched);
    expect(runRecordingMock).toHaveBeenCalledOnce();
  });

  it("does NOT touch a row that is already `recorded`", async () => {
    // 6afa536. A redelivery used to rewrite `payment_details` on a row whose
    // payments were already in ByDesign, so the stored ledger drifted from what
    // was actually sent — and before 6fe8ea2 it also regressed the status and
    // recorded the whole set again.
    setLedgerRow(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.recorded,
        recordedAt: new Date(),
        paymentDetails: p2mBody.payment_details,
      }),
    );

    const outcome = await processMoolaWebhook(p2mBody);

    expect(outcome).toEqual({ handled: true, reason: "terminal_skipped" });
    expect(mockPrisma.moolaPayment.update).not.toHaveBeenCalled();
    expect(runRecordingMock).not.toHaveBeenCalled();
  });

  it("does NOT touch a row that is already `failed`", async () => {
    setLedgerRow(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.failed,
        bydesignRecordingAttempts: 5,
      }),
    );

    const outcome = await processMoolaWebhook(p2mBody);

    expect(outcome).toEqual({ handled: true, reason: "terminal_skipped" });
    expect(mockPrisma.moolaPayment.update).not.toHaveBeenCalled();
  });

  it("guards the CARD webhook branch too, not just the payment branch", async () => {
    setLedgerRow(
      ledgerRow({ status: MOOLA_PAYMENT_STATUS.recorded }),
    );

    const outcome = await processMoolaWebhook({
      type: "transaction",
      transaction_type: "load_funds_via_card",
      invoice_number: "NULF-CT:cart_1",
      card_number_last4: "7999",
      expiry_date: "8/2029",
      payment_instrument_uuid: "pi_1",
    });

    expect(outcome).toEqual({ handled: true, reason: "terminal_skipped" });
    expect(mockPrisma.moolaPayment.update).not.toHaveBeenCalled();
  });

  it("creates the ledger row on a first delivery for an unknown cart", async () => {
    mockPrisma.moolaPayment.findUnique.mockResolvedValue(null);
    mockPrisma.moolaPayment.create.mockResolvedValue(
      ledgerRow({ bydesignOrderId: null }),
    );

    await processMoolaWebhook(p2mBody);

    expect(mockPrisma.moolaPayment.create).toHaveBeenCalledWith({
      data: { cartToken: "cart_1", invoiceNumber: "NULF-CT:cart_1" },
    });
  });

  it("picks up a row abandoned in `recording`, which nothing else would", async () => {
    // `determineStatus` preserves `recording` and `readyToRecord` is false for
    // it, so keying the trigger on readiness alone left a row whose run died
    // sitting there forever — the stale-claim reclaim was unreachable.
    setLedgerRow(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.recording,
        recordingClaimedAt: new Date(Date.now() - 60 * 60 * 1000),
        paymentDetails: p2mBody.payment_details,
      }),
    );

    await processMoolaWebhook(p2mBody);

    expect(runRecordingMock).toHaveBeenCalledOnce();
  });

  it("leaves a LIVE recording claim alone", async () => {
    setLedgerRow(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.recording,
        recordingClaimedAt: new Date(),
        paymentDetails: p2mBody.payment_details,
      }),
    );

    await processMoolaWebhook(p2mBody);

    expect(runRecordingMock).not.toHaveBeenCalled();
  });

  it("reports a retryable recording failure so the caller can ask for a re-delivery", async () => {
    setLedgerRow(ledgerRow());
    runRecordingMock.mockResolvedValue({
      ran: true,
      reason: "partial_failure",
      results: [],
      needsRetry: true,
    });

    const outcome = await processMoolaWebhook(p2mBody);

    expect(outcome.recordingNeedsRetry).toBe(true);
  });

  it("refuses a transaction type it does not handle", async () => {
    const outcome = await processMoolaWebhook({
      type: "transaction",
      transaction_type: "something_else",
      invoice_number: "NULF-CT:cart_1",
    });

    expect(outcome).toEqual({
      handled: false,
      reason: "unsupported_transaction_type",
    });
    expect(mockPrisma.moolaPayment.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an invoice_number that is not one of ours", async () => {
    const outcome = await processMoolaWebhook({
      ...p2mBody,
      invoice_number: "SOMEONE-ELSE:cart_1",
    });

    expect(outcome).toEqual({ handled: false, reason: "invalid_invoice_number" });
    expect(mockPrisma.moolaPayment.findUnique).not.toHaveBeenCalled();
  });
});

describe("mergePaymentDetails", () => {
  it("merges a redelivery by line id rather than appending", () => {
    const existing = [{ id: "a", type: "uwallet", amount: "10", status: "Success" }];
    const incoming = [{ id: "a", type: "uwallet", amount: "10", status: "Success" }];

    expect(mergePaymentDetails(existing, incoming)).toHaveLength(1);
  });

  it("never lets a later Pending overwrite an earlier Success", () => {
    const merged = mergePaymentDetails(
      [{ id: "a", status: "Success", amount: "10" }],
      [{ id: "a", status: "Pending", amount: "10" }],
    );

    expect(merged[0].status).toBe("Success");
  });

  it("does promote Pending to Success when the later delivery is the better one", () => {
    const merged = mergePaymentDetails(
      [{ id: "a", status: "Pending" }],
      [{ id: "a", status: "Success" }],
    );

    expect(merged[0].status).toBe("Success");
  });

  it("keeps a line the redelivery omitted — partial re-sends happen", () => {
    const merged = mergePaymentDetails(
      [
        { id: "a", status: "Success" },
        { id: "b", status: "Success" },
      ],
      [{ id: "a", status: "Success" }],
    );

    expect(merged.map((line) => line.id)).toEqual(["a", "b"]);
  });

  it("appends a genuinely new line", () => {
    const merged = mergePaymentDetails(
      [{ id: "a", status: "Success" }],
      [{ id: "b", status: "Success" }],
    );

    expect(merged.map((line) => line.id)).toEqual(["a", "b"]);
  });

  it("prefers the incoming value for a non-status field when it is present", () => {
    const merged = mergePaymentDetails(
      [{ id: "a", order_reference: "OLD", status: "Success" }],
      [{ id: "a", order_reference: "NEW", status: "Success" }],
    );

    expect(merged[0].order_reference).toBe("NEW");
  });

  it("keeps the existing value when the incoming one is blank", () => {
    const merged = mergePaymentDetails(
      [{ id: "a", order_reference: "OLD", status: "Success" }],
      [{ id: "a", order_reference: "", status: "Success" }],
    );

    expect(merged[0].order_reference).toBe("OLD");
  });
});

describe("betterStatus", () => {
  it("ranks Success over Pending over Declined", () => {
    expect(betterStatus("Success", "Pending")).toBe("Success");
    expect(betterStatus("Pending", "Success")).toBe("Success");
    expect(betterStatus("Pending", "Declined")).toBe("Pending");
  });

  it("never lets an unrecognised status displace a known one", () => {
    expect(betterStatus("Whatever", "Pending")).toBe("Pending");
    expect(betterStatus("Pending", "Whatever")).toBe("Pending");
  });
});

describe("normalizePaymentDetails", () => {
  it("drops declined lines", () => {
    const lines = normalizePaymentDetails({
      payment_details: [
        { id: "a", status: "Success" },
        { id: "b", status: "Declined" },
      ],
    });

    expect(lines.map((line) => line.id)).toEqual(["a"]);
  });

  it("keeps only the six fields the ledger stores, and omits absent ones", () => {
    const [line] = normalizePaymentDetails({
      payment_details: [
        {
          id: "a",
          type: "uwallet",
          amount: "10",
          status: "Success",
          currency: null,
          order_reference: undefined,
          card_number: "4111111111111111",
        },
      ],
    });

    expect(Object.keys(line).sort()).toEqual(["amount", "id", "status", "type"]);
    // A card number arriving in a payment line is not carried into the ledger.
    expect(line.card_number).toBeUndefined();
  });
});

describe("extractCardDetails", () => {
  it("takes only the card fields, and drops absent ones", () => {
    expect(
      extractCardDetails({
        id: "txn_1",
        card_number_last4: "7999",
        expiry_date: "8/2029",
        payment_instrument_uuid: "pi_1",
        parent_reference: undefined,
        unrelated: "x",
      }),
    ).toEqual({
      card_number_last4: "7999",
      expiry_date: "8/2029",
      payment_instrument_uuid: "pi_1",
      transaction_id: "txn_1",
    });
  });
});

describe("isValidTransaction", () => {
  it("requires both the envelope type and a known transaction type", () => {
    expect(isValidTransaction({ type: "transaction", transaction_type: "p2m" }))
      .toBe(true);
    expect(
      isValidTransaction({
        type: "transaction",
        transaction_type: "load_funds_via_card",
      }),
    ).toBe(true);
    expect(isValidTransaction({ type: "other", transaction_type: "p2m" })).toBe(
      false,
    );
    expect(isValidTransaction({ type: "transaction" })).toBe(false);
  });
});
