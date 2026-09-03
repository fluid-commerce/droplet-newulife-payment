/**
 * The ByDesign recording run.
 *
 * Every test here is about one question: can a payment be Saved to ByDesign
 * twice? The Save is irreversible and takes no idempotency key, so the answer
 * has to be no on every path — a re-delivered webhook, a retry after a partial
 * failure, a reclaimed stale run, and a raise that lands after the money moved.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockTx = vi.hoisted(() => ({
  $queryRaw: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
  moolaPayment: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  moolaPayment: { findUnique: vi.fn(), update: vi.fn() },
  bydesignPaymentReceipt: { findUnique: vi.fn(), create: vi.fn() },
}));

type ByDesignResult = {
  success: boolean;
  response?: Record<string, unknown> | null;
  error?: string | null;
};

const recordPaymentMock = vi.hoisted(() =>
  vi.fn<(args: unknown) => Promise<ByDesignResult>>(),
);
const postOrderMock = vi.hoisted(() =>
  vi.fn<(args: unknown) => Promise<ByDesignResult>>(),
);

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/bydesign", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/bydesign")>("@/lib/bydesign");
  return {
    ...actual,
    recordPayment: recordPaymentMock,
    postOrder: postOrderMock,
  };
});

const { runRecording, recordPaymentOnce, postOrderIfEligible } = await import(
  "./bydesign-recording"
);
const { MOOLA_PAYMENT_STATUS } = await import("./types");

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    cartToken: "cart_1",
    invoiceNumber: "NULF-CT:cart_1",
    fluidOrderId: "900",
    bydesignOrderId: "12345",
    moolaTransactionId: "txn_1",
    kycStatus: "APPROVE",
    transactionType: "p2m",
    paymentDetails: [
      { id: "PAY_A", type: "uwallet", amount: "10.00", status: "Success" },
    ],
    cardDetails: {},
    moolaWebhookPayload: {},
    fluidWebhookPayload: {},
    status: MOOLA_PAYMENT_STATUS.matched,
    bydesignRecordingAttempts: 0,
    lastError: null,
    matchedAt: new Date("2026-01-01T00:00:00Z"),
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

beforeEach(() => {
  vi.clearAllMocks();

  // `$transaction(fn)` runs the callback against a transaction client. The mock
  // keeps that shape rather than short-circuiting it, because claimForRecording
  // and recordFailure both do their real work inside it.
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
  );
  mockTx.$queryRaw.mockResolvedValue([{ id: 1n }]);
  mockTx.moolaPayment.update.mockImplementation(
    async ({ where, data }: { where: { id: bigint }; data: object }) =>
      ledgerRow({ id: where.id, ...data }),
  );
  mockPrisma.moolaPayment.update.mockImplementation(
    async ({ where, data }: { where: { id: bigint }; data: object }) =>
      ledgerRow({ id: where.id, ...data }),
  );
  mockPrisma.bydesignPaymentReceipt.findUnique.mockResolvedValue(null);
  mockPrisma.bydesignPaymentReceipt.create.mockResolvedValue({});
  recordPaymentMock.mockResolvedValue({
    success: true,
    response: { IsSuccessful: true },
  });
  postOrderMock.mockResolvedValue({ success: true });
});

describe("recordPaymentOnce — the receipt is the idempotency key", () => {
  const args = {
    payment: { id: "PAY_A", type: "uwallet", amount: "10.00", status: "Success" },
    p2mData: {},
    cardDetails: {},
    billingAddress: {},
  };

  it("Saves and THEN writes the receipt, in that order", async () => {
    // The order is the safety property, not just the fact that both happen.
    // Receipt-then-Save fails towards a payment that is never recorded and that
    // nothing retries; Save-then-receipt fails towards a duplicate, which is
    // the direction the whole design is arranged to avoid — so the ordering
    // has to be asserted, not assumed.
    const order: string[] = [];
    recordPaymentMock.mockImplementation(async () => {
      order.push("save");
      return { success: true, response: {} };
    });
    mockPrisma.bydesignPaymentReceipt.create.mockImplementation(async () => {
      order.push("receipt");
      return {};
    });

    const result = await recordPaymentOnce({ row: ledgerRow(), ...args });

    expect(result).toMatchObject({ paymentId: "PAY_A", success: true });
    expect(order).toEqual(["save", "receipt"]);
    expect(mockPrisma.bydesignPaymentReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bydesignOrderId: "12345",
        paymentDetailId: "PAY_A",
        cartToken: "cart_1",
      }),
    });
  });

  it("does NOT Save again when a receipt already exists", async () => {
    mockPrisma.bydesignPaymentReceipt.findUnique.mockResolvedValue({
      id: 1n,
      bydesignOrderId: "12345",
      paymentDetailId: "PAY_A",
    });

    const result = await recordPaymentOnce({ row: ledgerRow(), ...args });

    expect(result).toMatchObject({ success: true, alreadyRecorded: true });
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });

  it("refuses to Save a payment line with no id, rather than Saving it unguarded", async () => {
    // Without a stable line id there is nothing to key a receipt on, so a retry
    // could not tell this line from a new one.
    const result = await recordPaymentOnce({
      row: ledgerRow(),
      ...args,
      payment: { type: "uwallet", amount: "10.00", status: "Success" },
    });

    expect(result.success).toBe(false);
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });

  it("reports the line as failed when the receipt cannot be written", async () => {
    // The Save landed. Without the receipt, claiming success would mark the
    // cart recorded on the strength of bookkeeping that did not happen.
    mockPrisma.bydesignPaymentReceipt.create.mockRejectedValue(
      new Error("disk full"),
    );

    const result = await recordPaymentOnce({ row: ledgerRow(), ...args });

    expect(result.success).toBe(false);
    expect(result.error).toContain("receipt");
  });

  it("treats a unique-constraint clash on the receipt as an already-recorded line", async () => {
    mockPrisma.bydesignPaymentReceipt.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6",
      }),
    );

    const result = await recordPaymentOnce({ row: ledgerRow(), ...args });

    expect(result).toMatchObject({ success: true, alreadyRecorded: true });
  });

  it("skips a declined line without calling ByDesign", async () => {
    const result = await recordPaymentOnce({
      row: ledgerRow(),
      ...args,
      payment: { id: "PAY_A", type: "uwallet", status: "Declined" },
    });

    expect(result).toMatchObject({ success: true, skipped: true });
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });
});

describe("runRecording — the claim", () => {
  it("records, marks the row terminal, and posts the order", async () => {
    mockTx.moolaPayment.findUnique.mockResolvedValue(ledgerRow());

    const outcome = await runRecording(1n);

    expect(outcome).toMatchObject({ ran: true, reason: "recorded" });
    expect(recordPaymentMock).toHaveBeenCalledOnce();
    expect(mockPrisma.moolaPayment.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: expect.objectContaining({ status: MOOLA_PAYMENT_STATUS.recorded }),
    });
    expect(postOrderMock).toHaveBeenCalledOnce();
  });

  it("refuses to claim a row that is already `recorded`", async () => {
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({ status: MOOLA_PAYMENT_STATUS.recorded }),
    );

    const outcome = await runRecording(1n);

    expect(outcome).toMatchObject({ ran: false, reason: "terminal" });
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });

  it("refuses to claim a row that is already `failed`", async () => {
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({ status: MOOLA_PAYMENT_STATUS.failed }),
    );

    expect(await runRecording(1n)).toMatchObject({ reason: "terminal" });
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });

  it("refuses to claim a row another run is holding", async () => {
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.recording,
        recordingClaimedAt: new Date(),
      }),
    );

    const outcome = await runRecording(1n);

    expect(outcome).toMatchObject({ reason: "in_progress" });
    expect(recordPaymentMock).not.toHaveBeenCalled();
    // Worth coming back for, unlike terminal/not-found/not-ready — another run
    // holds it right now.
    expect(outcome.needsRetry).toBe(true);
  });

  it("does NOT reclaim on the strength of a stale updated_at alone", async () => {
    // The expiry keys on `recording_claimed_at`, not `updated_at`. An inbound
    // webhook writes to the row while a run holds it (merging payment details),
    // and keying on `updated_at` would let those writes push an abandoned
    // claim's expiry out forever — or, the other way round, let a quiet-but-live
    // run be reclaimed underneath itself.
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.recording,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        recordingClaimedAt: new Date(),
      }),
    );

    expect(await runRecording(1n)).toMatchObject({ reason: "in_progress" });
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });

  it("reclaims a claim that has been held past the stale threshold", async () => {
    // Nothing else retries an abandoned run — there is no queue. Reclaiming is
    // only safe because the receipts make each Save idempotent.
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({
        status: MOOLA_PAYMENT_STATUS.recording,
        recordingClaimedAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );

    const outcome = await runRecording(1n);

    expect(outcome.ran).toBe(true);
    expect(recordPaymentMock).toHaveBeenCalledOnce();
  });

  it("refuses to claim a row that is not ready", async () => {
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({ status: MOOLA_PAYMENT_STATUS.pending }),
    );

    expect(await runRecording(1n)).toMatchObject({ reason: "not_ready" });
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });
});

describe("runRecording — failure never regresses a terminal row", () => {
  it("on a partial failure, marks the cart matched and records only the attempt", async () => {
    // Rails path (c): two lines, one Saved, one not. The status goes back to
    // `matched` so the run can be retried — which is exactly why the receipt
    // for the line that DID land has to exist.
    const twoLines = [
      { id: "PAY_A", type: "uwallet", amount: "10", status: "Success" },
      { id: "PAY_B", type: "uwallet", amount: "20", status: "Success" },
    ];
    mockTx.moolaPayment.findUnique.mockResolvedValue(
      ledgerRow({ paymentDetails: twoLines }),
    );
    // The claim returns the row it just wrote, so it has to carry both lines.
    mockTx.moolaPayment.update.mockImplementation(
      async ({ where, data }: { where: { id: bigint }; data: object }) =>
        ledgerRow({ id: where.id, paymentDetails: twoLines, ...data }),
    );
    recordPaymentMock
      .mockResolvedValueOnce({ success: true, response: {} })
      .mockResolvedValueOnce({ success: false, error: "ByDesign said no" });

    const outcome = await runRecording(1n);

    expect(outcome.reason).toBe("partial_failure");
    // The successful line was receipted, so a retry will not Save it again.
    expect(mockPrisma.bydesignPaymentReceipt.create).toHaveBeenCalledOnce();
    // And the row is NOT marked recorded.
    expect(mockPrisma.moolaPayment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MOOLA_PAYMENT_STATUS.recorded }),
      }),
    );
    const failureWrite = mockTx.moolaPayment.update.mock.calls.at(-1)![0];
    expect(failureWrite.data.status).toBe(MOOLA_PAYMENT_STATUS.matched);
    expect(failureWrite.data.bydesignRecordingAttempts).toBe(1);
    // The caller turns this into a 5xx so the delivery is re-sent. Without it
    // the row would sit in `matched` forever behind an already-sent 202 —
    // there is no queue to come back for it.
    expect(outcome.needsRetry).toBe(true);
  });

  it("gives up into `failed` once the attempt limit is reached", async () => {
    mockTx.moolaPayment.findUnique
      .mockResolvedValueOnce(ledgerRow({ bydesignRecordingAttempts: 4 }))
      .mockResolvedValue(ledgerRow({ bydesignRecordingAttempts: 4 }));
    recordPaymentMock.mockResolvedValue({ success: false, error: "nope" });

    const outcome = await runRecording(1n);

    const failureWrite = mockTx.moolaPayment.update.mock.calls.at(-1)![0];
    expect(failureWrite.data.status).toBe(MOOLA_PAYMENT_STATUS.failed);
    // Terminal: re-delivering achieves nothing, so stop asking for a retry.
    expect(outcome.needsRetry).toBe(false);
  });

  it("will NOT move a row out of `recorded` when a failure is written", async () => {
    // Rails paths (a) and (b): `handle_error` wrote `status: :matched`
    // unconditionally, so a raise AFTER the payments were recorded — on the
    // status write itself, or while posting the order — put a terminal row back
    // into a re-runnable state and the whole set was Saved again.
    mockTx.moolaPayment.findUnique
      // The claim sees a claimable row...
      .mockResolvedValueOnce(ledgerRow({ status: MOOLA_PAYMENT_STATUS.matched }))
      // ...and by the time the failure is written it has become terminal.
      .mockResolvedValue(ledgerRow({ status: MOOLA_PAYMENT_STATUS.recorded }));
    recordPaymentMock.mockResolvedValue({ success: false, error: "nope" });

    await runRecording(1n);

    const failureWrite = mockTx.moolaPayment.update.mock.calls.at(-1)![0];
    expect(failureWrite.data.status).toBeUndefined();
    expect(failureWrite.data.lastError).toContain("nope");
  });
});

describe("postOrderIfEligible", () => {
  it("does not post twice", async () => {
    await postOrderIfEligible(ledgerRow({ orderPostedAt: new Date() }));
    expect(postOrderMock).not.toHaveBeenCalled();
  });

  it("does not post when a cash line is present", async () => {
    await postOrderIfEligible(
      ledgerRow({
        paymentDetails: [
          { id: "a", type: "LOAD_FUNDS_VIA_CASH", status: "Success" },
        ],
      }),
    );
    expect(postOrderMock).not.toHaveBeenCalled();
  });

  it("swallows a raise rather than letting it reach the run's failure handler", async () => {
    // The payments are already in ByDesign at this point. Rails let a raise
    // here regress the row; here it cannot escape.
    postOrderMock.mockRejectedValue(new Error("ByDesign is down"));

    await expect(postOrderIfEligible(ledgerRow())).resolves.toBeUndefined();
  });
});
