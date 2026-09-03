/**
 * The `redirect_cart_payment` callback route.
 *
 * Two things are being asserted, and the second is the one that is easy to get
 * wrong:
 *
 *  1. a correctly signed request reaches the handler (without this, a totally
 *     misconfigured route would pass every rejection test), and
 *  2. every refusal answers the SAME 200 body — byte-identical — so the route
 *     is not an oracle telling a caller which failure they hit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { companyFixture, registrationFixture } from "@/test/factories";
import { signedCallbackRequest } from "@/test/signing";

const mockPrisma = vi.hoisted(() => ({
  company: { findFirst: vi.fn() },
  fluidCallbackRegistration: { findUnique: vi.fn() },
}));

const getRedirectUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/checkout", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/checkout")>("@/lib/checkout");
  return { ...actual, getRedirectUrl: getRedirectUrlMock };
});

const { POST } = await import("./route");
const { NEUTRAL_RESULT } = await import("@/lib/checkout");

const TOKEN = "cvt_live_token";
const { tokenDigest } = await import("@fluid-app/droplet-sdk");

const cartBody = {
  payment_account_id: "223",
  customer: { external_id: "900" },
  cart: {
    cart_token: "cart_1",
    amount_total: "878.50",
    currency_code: "USD",
    email: "shopper@example.com",
    ship_to: { first_name: "Emma", last_name: "Stone", country_code: "US" },
    items: [{ product_title: "Widget", quantity: 1, price: "10", product: { sku: "S" } }],
  },
};

/** The exact bytes a refusal answers with. */
const NEUTRAL_BODY = JSON.stringify(NEUTRAL_RESULT);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.fluidCallbackRegistration.findUnique.mockResolvedValue(
    registrationFixture({ tokenDigest: tokenDigest(TOKEN) }),
  );
  mockPrisma.company.findFirst.mockResolvedValue(companyFixture());
  getRedirectUrlMock.mockResolvedValue({
    redirect_url: "https://upayments.test/pay/abc",
  });
});

describe("POST /api/callbacks/redirect-cart-payment", () => {
  it("serves a correctly signed request and returns the uPayments url", async () => {
    const response = await POST(
      signedCallbackRequest({ token: TOKEN, body: cartBody }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirect_url: "https://upayments.test/pay/abc",
    });
    expect(getRedirectUrlMock).toHaveBeenCalledOnce();
  });

  it("resolves the tenant from the registration's dri and nothing else", async () => {
    await POST(signedCallbackRequest({ token: TOKEN, body: cartBody }));

    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith({
      where: {
        dropletInstallationUuid: "dri_acme",
        active: true,
        uninstalledAt: null,
      },
    });
  });

  it("answers the neutral 200 for an unknown token, and does not run the handler", async () => {
    mockPrisma.fluidCallbackRegistration.findUnique.mockResolvedValue(null);

    const response = await POST(
      signedCallbackRequest({ token: "cvt_not_ours", body: cartBody }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
    expect(getRedirectUrlMock).not.toHaveBeenCalled();
  });

  it("answers the neutral 200 for a bad signature", async () => {
    const response = await POST(
      signedCallbackRequest({
        token: TOKEN,
        body: cartBody,
        signingToken: "some-other-token",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
    expect(getRedirectUrlMock).not.toHaveBeenCalled();
  });

  it("answers the neutral 200 when the token belongs to another definition", async () => {
    // Stops a token issued for one definition being replayed at this route.
    mockPrisma.fluidCallbackRegistration.findUnique.mockResolvedValue(
      registrationFixture({
        tokenDigest: tokenDigest(TOKEN),
        definitionName: "update_cart_tax",
      }),
    );

    const response = await POST(
      signedCallbackRequest({ token: TOKEN, body: cartBody }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
    expect(getRedirectUrlMock).not.toHaveBeenCalled();
  });

  it("answers the neutral 200 when the registration resolves to no company", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const response = await POST(
      signedCallbackRequest({ token: TOKEN, body: cartBody }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
    expect(getRedirectUrlMock).not.toHaveBeenCalled();
  });

  it("answers the neutral 200 when the token store is unreachable", async () => {
    // Deploying before the fluid_callback_registrations migration ran looks
    // exactly like this. It must not become a 500 on a checkout-blocking route.
    mockPrisma.fluidCallbackRegistration.findUnique.mockRejectedValue(
      new Error('relation "fluid_callback_registrations" does not exist'),
    );

    const response = await POST(
      signedCallbackRequest({ token: TOKEN, body: cartBody }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
  });

  it("answers the neutral 200 for a verified body with no cart", async () => {
    // `cart` is REQUIRED by the definition. Rails raised NoMethodError here and
    // returned an HTTP 500.
    const response = await POST(
      signedCallbackRequest({
        token: TOKEN,
        body: { payment_account_id: "223" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
    expect(getRedirectUrlMock).not.toHaveBeenCalled();
  });

  it("answers the neutral 200 when the handler throws", async () => {
    // The uPayments clients raise on a missing key or a non-JSON gateway page.
    // Rails let those become HTTP 500s.
    getRedirectUrlMock.mockRejectedValue(
      new Error("NEWULIFE_PRIVATE_KEY not found in environment variables"),
    );

    const response = await POST(
      signedCallbackRequest({ token: TOKEN, body: cartBody }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
  });

  it("answers the neutral 200 for a stale signature", async () => {
    const response = await POST(
      signedCallbackRequest({
        token: TOKEN,
        body: cartBody,
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NEUTRAL_BODY);
  });

  it("gives an identical body on every refusal, so it is not an oracle", async () => {
    const bodies: string[] = [];

    mockPrisma.fluidCallbackRegistration.findUnique.mockResolvedValueOnce(null);
    bodies.push(
      await (await POST(signedCallbackRequest({ token: "x", body: cartBody })))
        .text(),
    );

    bodies.push(
      await (
        await POST(
          signedCallbackRequest({
            token: TOKEN,
            body: cartBody,
            signingToken: "wrong",
          }),
        )
      ).text(),
    );

    bodies.push(
      await (
        await POST(
          signedCallbackRequest({ token: TOKEN, body: { no: "cart" } }),
        )
      ).text(),
    );

    getRedirectUrlMock.mockRejectedValueOnce(new Error("boom"));
    bodies.push(
      await (await POST(signedCallbackRequest({ token: TOKEN, body: cartBody })))
        .text(),
    );

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(NEUTRAL_BODY);
  });
});
