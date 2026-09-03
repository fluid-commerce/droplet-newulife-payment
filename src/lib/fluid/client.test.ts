import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { FluidClient, FluidAuthenticationError } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FluidClient", () => {
  it("forwards page and per_page on listCallbacks", async () => {
    // The endpoint is company-scoped and defaults to 10 per page. A client that
    // drops these silently sees only the first ten of a list that also contains
    // other droplets' registrations — so a backfill adopts a fraction of what
    // it should, and every later callback is refused.
    fetchMock.mockResolvedValue(jsonResponse({ callback_registrations: [] }));

    const client = new FluidClient("token", "https://api.fluid.test");
    await client.listCallbacks({ page: 3, per_page: 100 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/callback/registrations?page=3&per_page=100",
    );
  });

  it("omits the query string entirely when given no params", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ callback_registrations: [] }));

    const client = new FluidClient("token", "https://api.fluid.test");
    await client.listCallbacks();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/callback/registrations",
    );
  });

  it("does not share credentials between instances", async () => {
    // The Ruby client set its Authorization header on the HTTParty CLASS, so
    // constructing a second FluidClient replaced the first one's token and a
    // request meant for company A went out as company B.
    // A fresh Response each call: a Response body can only be read once.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ callback_registrations: [] }),
    );

    const a = new FluidClient("token-a", "https://api.fluid.test");
    const b = new FluidClient("token-b", "https://api.fluid.test");

    await b.listCallbacks();
    await a.listCallbacks();

    const headersOf = (call: number) =>
      (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<
        string,
        string
      >;

    expect(headersOf(0).Authorization).toBe("Bearer token-b");
    expect(headersOf(1).Authorization).toBe("Bearer token-a");
  });

  it("raises a typed error for a 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 401));

    const client = new FluidClient("token", "https://api.fluid.test");
    await expect(client.listCallbacks()).rejects.toBeInstanceOf(
      FluidAuthenticationError,
    );
  });

  it("posts callback registrations to /api/callback/registrations", async () => {
    // /api/company/callbacks does not exist in Fluid. The callback endpoints
    // live under /api/callback/*; see config/routes/integrations.rb.
    fetchMock.mockResolvedValue(
      jsonResponse({
        callback_registration: {
          uuid: "cbr_1",
          definition_name: "redirect_cart_payment",
          url: "https://droplet.test/api/callbacks/redirect-cart-payment",
        },
      }),
    );

    const client = new FluidClient("token", "https://api.fluid.test");
    await client.createCallback({
      definition_name: "redirect_cart_payment",
      url: "https://droplet.test/api/callbacks/redirect-cart-payment",
      timeout_in_seconds: 20,
      active: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/callback/registrations",
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body.callback_registration.definition_name).toBe("redirect_cart_payment");
  });

  it("tolerates a 204 with no body on delete", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const client = new FluidClient("token", "https://api.fluid.test");
    await expect(client.deleteCallback("cbr_1")).resolves.toBeUndefined();
  });
});
