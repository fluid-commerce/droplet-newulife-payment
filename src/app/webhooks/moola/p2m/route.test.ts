/**
 * The Moola webhook route.
 *
 * The opposite policy to the callback: this is not the checkout path, Moola
 * retries a non-2xx, and the payload flows straight into the ByDesign recording
 * path. So it refuses loudly, and it refuses when it is not configured.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

type WebhookOutcome = {
  handled: boolean;
  reason: string;
  recordingNeedsRetry?: boolean;
};

const processMoolaWebhookMock = vi.hoisted(() =>
  vi.fn<(payload: Record<string, unknown>) => Promise<WebhookOutcome>>(),
);

vi.mock("@/lib/payments", () => ({
  processMoolaWebhook: processMoolaWebhookMock,
}));

const { POST } = await import("./route");

const SECRET = "moola-shared-secret";

const body = {
  type: "transaction",
  transaction_type: "p2m",
  invoice_number: "NULF-CT:cart_1",
  kycStatus: "APPROVE",
  payment_details: [
    { id: "PAY_A", type: "uwallet", amount: "878.00", status: "Success" },
  ],
};

function signedRequest({
  secret = SECRET,
  payload = body,
  header = "x-moola-signature",
  signature,
}: {
  secret?: string;
  payload?: unknown;
  header?: string;
  signature?: string;
} = {}): Request {
  const serialized = JSON.stringify(payload);
  return new Request("https://droplet.test/webhooks/moola/p2m", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [header]:
        signature ??
        createHmac("sha256", secret).update(serialized, "utf8").digest("hex"),
    },
    body: serialized,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOOLA_WEBHOOK_SECRET = SECRET;
  processMoolaWebhookMock.mockResolvedValue({
    handled: true,
    reason: "processed",
  });
});

describe("POST /webhooks/moola/p2m", () => {
  it("accepts a correctly signed delivery and hands the parsed body on", async () => {
    const response = await POST(signedRequest());

    expect(response.status).toBe(202);
    expect(processMoolaWebhookMock).toHaveBeenCalledOnce();
    expect(processMoolaWebhookMock.mock.calls[0][0]).toEqual(body);
  });

  it("accepts the alternative header name Rails also accepted", async () => {
    const response = await POST(
      signedRequest({ header: "x-webhook-signature" }),
    );

    expect(response.status).toBe(202);
  });

  it("refuses a delivery signed with the wrong secret", async () => {
    const response = await POST(signedRequest({ secret: "not-the-secret" }));

    expect(response.status).toBe(401);
    expect(processMoolaWebhookMock).not.toHaveBeenCalled();
  });

  it("refuses a delivery with no signature header", async () => {
    const response = await POST(
      new Request("https://droplet.test/webhooks/moola/p2m", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(401);
    expect(processMoolaWebhookMock).not.toHaveBeenCalled();
  });

  it("refuses a signature that is valid hex plus trailing junk", async () => {
    // `Buffer.from(s, "hex")` truncates at the first invalid character rather
    // than throwing, so a valid prefix would otherwise compare equal.
    const valid = createHmac("sha256", SECRET)
      .update(JSON.stringify(body), "utf8")
      .digest("hex");
    const response = await POST(signedRequest({ signature: `${valid}zz` }));

    expect(response.status).toBe(401);
  });

  it("refuses EVERY delivery when MOOLA_WEBHOOK_SECRET is unset", async () => {
    // The Rails controller verifies `if: :signature_verification_enabled?`,
    // which is true only when the variable is set — so an unset secret makes
    // the endpoint accept anything, and an unauthenticated caller can post a
    // crafted invoice_number straight into the ByDesign recording path. The
    // variable appears in no deploy artefact in this repository.
    //
    // 500 rather than 401 on purpose: Moola retries a 5xx, so setting the
    // secret a minute later recovers the delivery.
    delete process.env.MOOLA_WEBHOOK_SECRET;

    const response = await POST(signedRequest());

    expect(response.status).toBe(500);
    expect(processMoolaWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const raw = "not json";
    const response = await POST(
      new Request("https://droplet.test/webhooks/moola/p2m", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-moola-signature": createHmac("sha256", SECRET)
            .update(raw, "utf8")
            .digest("hex"),
        },
        body: raw,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 400 for a signed body that is a JSON array", async () => {
    const response = await POST(signedRequest({ payload: [1, 2, 3] }));
    expect(response.status).toBe(400);
  });

  it("answers 500 so Moola retries when processing throws", async () => {
    processMoolaWebhookMock.mockRejectedValue(new Error("database down"));

    const response = await POST(signedRequest());

    expect(response.status).toBe(500);
  });

  it("answers 5xx when the ByDesign recording did not finish, so Moola re-delivers", async () => {
    // There is no queue. Rails retried the recording job five times; here the
    // DELIVERY is the retry, and answering 202 would strand the row in
    // `matched` forever with nothing coming back for it.
    processMoolaWebhookMock.mockResolvedValue({
      handled: true,
      reason: "processed",
      recordingNeedsRetry: true,
    });

    const response = await POST(signedRequest());

    expect(response.status).toBe(503);
  });

  it("still answers 202 when the payload is one it deliberately ignores", async () => {
    // A redelivery for an already-recorded cart is `terminal_skipped`. Answering
    // anything but 2xx would make Moola re-send it forever.
    processMoolaWebhookMock.mockResolvedValue({
      handled: true,
      reason: "terminal_skipped",
    });

    const response = await POST(signedRequest());

    expect(response.status).toBe(202);
  });
});
