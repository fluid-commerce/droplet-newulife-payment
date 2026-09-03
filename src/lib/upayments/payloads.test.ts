/**
 * The uPayments request bodies, and the RS512 JWT that authenticates them.
 *
 * The JWT tests verify a real signature rather than asserting the token is a
 * non-empty string: the whole point of porting the signing is that uPayments
 * must be able to verify it, and a token that is merely well-shaped would pass
 * a shape test and fail in production.
 */

import { describe, it, expect } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";

import { generateJwt, JWT_ISSUER, TOKEN_TTL_SECONDS, loadPrivateKey } from "./jwt";
import { generateConsumerPayload, generateOrderPayload, PRODUCT_IDS } from "./payloads";
import { money, present } from "./cart";
import type { Cart } from "./cart";

const cart: Cart = {
  cart_token: "cart_1",
  amount_total: "878.5",
  tax_total: "0",
  shipping_total: "12.5",
  currency_code: "USD",
  language_iso: "en",
  recurring: false,
  email: "shopper@example.com",
  ship_to: {
    first_name: "Emma",
    last_name: "Stone",
    name: "Emma Stone",
    address1: "123 California Ave",
    address2: null,
    city: "Santa Monica",
    state: "CA",
    postal_code: "90403",
    country_code: "US",
    email: "shopper@example.com",
  },
  items: [
    {
      product_title: "Widget",
      quantity: 2,
      price: "10.00",
      product: { sku: "SKU-1" },
    },
  ],
};

const urls = {
  dropletHostUrl: "https://droplet.test",
  checkoutHostUrl: "https://checkout.test",
};

describe("generateOrderPayload", () => {
  it("builds the redirect back to THIS droplet's success route", () => {
    // The url is baked into the uPayments order at creation, so an order opened
    // before a cutover keeps pointing at whichever host created it. That is why
    // the Next app serves the success route at the same path Rails does.
    const payload = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "wallet-uuid",
      ...urls,
    });

    expect(payload.redirectUrl).toBe(
      "https://droplet.test/checkout/success/cart_1/payment_account/223",
    );
    expect(payload.cancelUrl).toBe("https://checkout.test/checkouts/cart_1");
  });

  it("uses the NULF-CT invoice number, which is the join key from Moola back", () => {
    const payload = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });

    expect(payload.invoiceNumber).toBe("NULF-CT:cart_1");
  });

  it("formats money to two places", () => {
    const payload = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });

    expect(payload.totalAmount).toBe("878.50");
  });

  it("omits salesTax when the tax total formats to 0.00, and sends it otherwise", () => {
    const zero = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });
    expect("salesTax" in zero).toBe(false);

    const taxed = generateOrderPayload({
      cart: { ...cart, tax_total: "7.25" },
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });
    expect(taxed.salesTax).toBe("7.25");
  });

  it("sends the shipping total as exciseTax", () => {
    // Not a typo — see 03098eb, "send shipping amount to UPayments as exciseTax".
    const payload = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });

    expect(payload.exciseTax).toBe("12.50");
  });

  it("omits exciseTax when shipping is absent or zero", () => {
    const payload = generateOrderPayload({
      cart: { ...cart, shipping_total: null },
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });

    expect("exciseTax" in payload).toBe(false);
  });

  it("reads `recurring` the way Ruby's present? does", () => {
    const notRecurring = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });
    expect(notRecurring.autoshipRequired).toBe(false);

    const recurring = generateOrderPayload({
      cart: { ...cart, recurring: { interval: "monthly" } },
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });
    expect(recurring.autoshipRequired).toBe(true);
  });

  it("maps the cart's items to productDetails", () => {
    const payload = generateOrderPayload({
      cart,
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });

    expect(payload.productDetails).toEqual([
      {
        productId: "SKU-1",
        description: "Widget",
        quantity: "2",
        unitPrice: "10.00",
      },
    ]);
  });

  it("sends an empty productDetails rather than throwing when items are missing", () => {
    // Ruby raised NoMethodError here, which surfaced as an HTTP 500 on a
    // checkout-blocking callback.
    const payload = generateOrderPayload({
      cart: { ...cart, items: null },
      externalId: "C900",
      paymentAccountId: "223",
      loginUuid: "w",
      ...urls,
    });

    expect(payload.productDetails).toEqual([]);
  });
});

describe("generateConsumerPayload", () => {
  it("picks the product uuid from the cart's currency", () => {
    const payload = generateConsumerPayload({ cart, externalId: "C900" });
    expect(payload.product_uuid).toBe(PRODUCT_IDS.USD);
    expect(payload.primaryWallet).toBe("USD");
  });

  it("sends a null product uuid for a currency with no mapping", () => {
    const payload = generateConsumerPayload({
      cart: { ...cart, currency_code: "ZZZ" },
      externalId: "C900",
    });
    expect(payload.product_uuid).toBeNull();
  });
});

describe("present — Ruby's Object#present?", () => {
  it("treats false, empty strings and empty collections as blank", () => {
    expect(present(false)).toBe(false);
    expect(present("")).toBe(false);
    expect(present("  ")).toBe(false);
    expect(present([])).toBe(false);
    expect(present({})).toBe(false);
    expect(present(null)).toBe(false);
    expect(present(undefined)).toBe(false);
  });

  it("treats the STRING 'false' as present, as Ruby does", () => {
    expect(present("false")).toBe(true);
  });

  it("treats 0 as present, as Ruby does", () => {
    expect(present(0)).toBe(true);
  });
});

describe("money", () => {
  it("formats numeric strings and numbers alike", () => {
    expect(money("12.5")).toBe("12.50");
    expect(money(12.5)).toBe("12.50");
    expect(money(0)).toBe("0.00");
  });

  it("degrades a non-numeric value to 0.00 rather than NaN", () => {
    expect(money("abc")).toBe("0.00");
    expect(money(undefined)).toBe("0.00");
  });
});

describe("generateJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  it("produces a token uPayments can verify with the matching public key", () => {
    const token = generateJwt({
      privateKey,
      apiCode: "api-code",
      now: 1_700_000_000,
    });

    const [header, payload, signature] = token.split(".");
    const verified = createVerify("RSA-SHA512")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));

    expect(verified).toBe(true);
  });

  it("does not verify against a different key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = generateJwt({ privateKey, apiCode: "x", now: 1_700_000_000 });
    const [header, payload, signature] = token.split(".");

    expect(
      createVerify("RSA-SHA512")
        .update(`${header}.${payload}`)
        .verify(other.publicKey, Buffer.from(signature, "base64url")),
    ).toBe(false);
  });

  it("writes exactly the header ruby-jwt writes — alg only, no typ", () => {
    const token = generateJwt({ privateKey, apiCode: "x", now: 1_700_000_000 });
    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString(),
    );

    expect(header).toEqual({ alg: "RS512" });
  });

  it("writes the four claims the Ruby writes, misspelled issuer included", () => {
    const token = generateJwt({
      privateKey,
      apiCode: "api-code",
      now: 1_700_000_000,
    });
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );

    expect(claims).toEqual({
      sub: "api-code",
      iss: JWT_ISSUER,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + TOKEN_TTL_SECONDS,
    });
  });
});

describe("loadPrivateKey", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("accepts a key whose newlines are literal backslash-n", () => {
    // Cloud Run values are often set that way, and the Ruby converted them.
    process.env.TEST_KEY_ESCAPED = pem.replace(/\n/g, "\\n");
    const loaded = loadPrivateKey("TEST_KEY_ESCAPED");

    expect(
      createPublicKey(loaded).export({ type: "spki", format: "pem" }),
    ).toBe(createPublicKey(privateKey).export({ type: "spki", format: "pem" }));

    delete process.env.TEST_KEY_ESCAPED;
  });

  it("names the variable and not its value when it is missing", () => {
    delete process.env.TEST_KEY_MISSING;
    expect(() => loadPrivateKey("TEST_KEY_MISSING")).toThrow(
      "TEST_KEY_MISSING not found",
    );
  });

  it("names the variable and not its value when it is unparseable", () => {
    process.env.TEST_KEY_BAD = "not a key";
    expect(() => loadPrivateKey("TEST_KEY_BAD")).toThrow(
      /Invalid private key format in TEST_KEY_BAD/,
    );
    delete process.env.TEST_KEY_BAD;
  });
});
