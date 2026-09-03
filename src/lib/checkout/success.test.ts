/**
 * The uPayments browser return.
 *
 * The replay tests are the point. This URL is in the shopper's address bar,
 * they can refresh it, and each load used to create a Fluid payment and check
 * the cart out into an ORDER.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTx = vi.hoisted(() => ({
  $queryRaw: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
  moolaPayment: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
}));

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  moolaPayment: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  setting: { findUnique: vi.fn(), upsert: vi.fn() },
}));

const createPayment = vi.hoisted(() => vi.fn());
const checkoutCart = vi.hoisted(() => vi.fn());
const runRecordingMock = vi.hoisted(() =>
  vi.fn(async () => ({ ran: false, reason: "not_ready", results: [] })),
);

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/settings", () => ({
  fluidApiSettings: async () => ({
    api_key: "key",
    base_url: "https://api.fluid.test",
  }),
}));
vi.mock("@/lib/fluid", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fluid")>("@/lib/fluid");
  return {
    ...actual,
    createFluidClient: () => ({ createPayment, checkoutCart }),
  };
});
vi.mock("@/lib/payments", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/payments")>("@/lib/payments");
  return { ...actual, runRecording: runRecordingMock };
});

const {
  claimCheckout,
  completeCheckout,
  extractPaymentAccountId,
  extractStatus,
  CHECKOUT_CLAIM_TTL_MS,
} = await import("./success");
const { MOOLA_PAYMENT_STATUS } = await import("@/lib/payments");

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    cartToken: "cart_1",
    invoiceNumber: "NULF-CT:cart_1",
    fluidOrderId: null,
    bydesignOrderId: null,
    moolaTransactionId: null,
    kycStatus: null,
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

let current: ReturnType<typeof ledgerRow>;

/** Sets the row `claimCheckout` will read and lock. */
function setLedgerRow(row: ReturnType<typeof ledgerRow>) {
  current = row;
  mockPrisma.moolaPayment.findUnique.mockResolvedValue(row);
  mockTx.moolaPayment.findUniqueOrThrow.mockResolvedValue(row);
}

const checkoutResponse = {
  order: {
    id: 900,
    external_id: "12345",
    order_confirmation_url: "https://checkout.test/orders/900",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CHECKOUT_HOST_URL = "https://checkout.test";

  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
  );
  mockTx.$queryRaw.mockResolvedValue([{ id: 1n }]);
  current = ledgerRow();
  mockPrisma.moolaPayment.findUnique.mockResolvedValue(current);
  mockTx.moolaPayment.findUniqueOrThrow.mockResolvedValue(current);
  // Both update mocks merge onto the row the test set, not onto the default
  // fixture. Rebuilding from the default silently resets every field the test
  // configured — which is exactly the field each of these tests is about.
  const merge = async ({
    where,
    data,
  }: {
    where: { id: bigint };
    data: object;
  }) => ({ ...current, id: where.id, ...data });
  mockTx.moolaPayment.update.mockImplementation(merge);
  mockPrisma.moolaPayment.update.mockImplementation(merge);

  createPayment.mockResolvedValue({ payment: { uuid: "pay_uuid" } });
  checkoutCart.mockResolvedValue(checkoutResponse);
});

describe("extractStatus / extractPaymentAccountId", () => {
  it("reads a normal query parameter", () => {
    expect(extractStatus("SUCCESS", "223")).toBe("SUCCESS");
    expect(extractPaymentAccountId("223")).toBe("223");
  });

  it("digs the status out of a payment_account_id it was concatenated into", () => {
    // Observed shape: uPayments returns to
    // `.../payment_account/223&status=SUCCESS` with the whole thing in one
    // path segment.
    expect(extractStatus(null, "223&status=SUCCESS")).toBe("SUCCESS");
    expect(extractPaymentAccountId("223&status=SUCCESS")).toBe("223");
  });

  it("returns null when there is no status anywhere", () => {
    expect(extractStatus(null, "223")).toBeNull();
    expect(extractPaymentAccountId(null)).toBeNull();
  });
});

describe("completeCheckout — the money calls", () => {
  it("creates the payment and checks the cart out, then returns the confirmation url", () => {
    return completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    }).then((outcome) => {
      expect(outcome).toEqual({
        kind: "confirmed",
        url: "https://checkout.test/orders/900",
      });
      expect(createPayment).toHaveBeenCalledWith("223", {
        cart_token: "cart_1",
        payment_method: { integration_class: "Droplet", source: "droplet" },
      });
      expect(checkoutCart).toHaveBeenCalledWith("cart_1", "pay_uuid");
    });
  });

  it("does nothing at all when the status is not SUCCESS", async () => {
    const outcome = await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "FAILED",
    });

    expect(outcome.kind).toBe("back_to_checkout");
    expect(createPayment).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("completeCheckout — replay", () => {
  it("REPLAYS a cart that already has a Fluid order instead of checking out again", async () => {
    // The refresh case. Rails re-ran both irreversible calls on every load.
    setLedgerRow(
      ledgerRow({
        fluidOrderId: "900",
        fluidWebhookPayload: checkoutResponse,
      }),
    );

    const outcome = await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    });

    expect(outcome).toEqual({
      kind: "confirmed",
      url: "https://checkout.test/orders/900",
    });
    expect(createPayment).not.toHaveBeenCalled();
    expect(checkoutCart).not.toHaveBeenCalled();
  });

  it("refuses a second checkout while one is in flight", async () => {
    // The double-click / two-tabs case.
    setLedgerRow(
      ledgerRow({ checkoutClaimedAt: new Date() }),
    );

    const outcome = await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    });

    expect(outcome.kind).toBe("back_to_checkout");
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("lets a claim older than the TTL be retaken", async () => {
    setLedgerRow(
      ledgerRow({
        checkoutClaimedAt: new Date(Date.now() - CHECKOUT_CLAIM_TTL_MS - 1000),
      }),
    );

    const outcome = await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    });

    expect(outcome.kind).toBe("confirmed");
    expect(createPayment).toHaveBeenCalledOnce();
  });

  it("HOLDS the claim when the checkout call fails", async () => {
    // Deliberate: the payment call already succeeded, so releasing the claim
    // would let a refresh create a second payment and a second order. A shopper
    // who has to wait is recoverable; a duplicate order is not.
    checkoutCart.mockRejectedValue(new Error("Fluid timed out"));

    const outcome = await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    });

    expect(outcome.kind).toBe("back_to_checkout");
    // Checked on BOTH clients: a release through the non-transactional client
    // would be just as much of a release.
    const releasedAnywhere = [
      ...mockTx.moolaPayment.update.mock.calls,
      ...mockPrisma.moolaPayment.update.mock.calls,
    ].some((call) => call[0].data.checkoutClaimedAt === null);
    expect(releasedAnywhere).toBe(false);
  });

  it("PERSISTS the Fluid payment uuid before checking the cart out", async () => {
    // The claim expires — it has to, or a first attempt that failed before
    // creating anything would wedge a cart the shopper has already paid for.
    // This is what stops that expiry turning into a second Fluid payment.
    await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    });

    const uuidWriteIndex = mockPrisma.moolaPayment.update.mock.calls.findIndex(
      (call) => call[0].data.fluidPaymentUuid === "pay_uuid",
    );
    expect(uuidWriteIndex).toBeGreaterThanOrEqual(0);
    // Written before the checkout call, not after it.
    expect(checkoutCart.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockPrisma.moolaPayment.update.mock.invocationCallOrder[uuidWriteIndex],
    );
  });

  it("REUSES an existing Fluid payment uuid instead of creating a second payment", async () => {
    setLedgerRow(
      ledgerRow({
        fluidPaymentUuid: "pay_from_a_previous_attempt",
        checkoutClaimedAt: new Date(Date.now() - CHECKOUT_CLAIM_TTL_MS - 1000),
      }),
    );

    const outcome = await completeCheckout({
      cartToken: "cart_1",
      paymentAccountId: "223",
      status: "SUCCESS",
    });

    expect(outcome.kind).toBe("confirmed");
    expect(createPayment).not.toHaveBeenCalled();
    expect(checkoutCart).toHaveBeenCalledWith(
      "cart_1",
      "pay_from_a_previous_attempt",
    );
  });
});

describe("claimCheckout", () => {
  it("takes the row lock before deciding anything", async () => {
    await claimCheckout("cart_1");

    expect(mockTx.$queryRaw).toHaveBeenCalled();
    const strings = mockTx.$queryRaw.mock.calls[0]?.[0] ?? [];
    expect(Array.from(strings).join("")).toContain("FOR UPDATE");
  });

  it("creates the ledger row when the Moola webhook has not landed yet", async () => {
    mockPrisma.moolaPayment.findUnique.mockResolvedValue(null);
    mockPrisma.moolaPayment.create.mockResolvedValue(ledgerRow());

    await claimCheckout("cart_1");

    expect(mockPrisma.moolaPayment.create).toHaveBeenCalledWith({
      data: { cartToken: "cart_1", invoiceNumber: "NULF-CT:cart_1" },
    });
  });
});
