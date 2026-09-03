/**
 * The ByDesign payment payload.
 *
 * These assert the exact field values the Ruby produces, because this is the
 * body that decides how much money is recorded against a real order and under
 * what status. A field that quietly changes shape in the port is a
 * reconciliation problem nobody notices for a month.
 */

import { describe, it, expect } from "vitest";

import {
  buildPaymentPayload,
  calculateAmount,
  calculatePromissoryAmount,
  determineEffectiveStatus,
  extractExpiry,
  extractLast4,
  normalizePaymentType,
  paymentDate,
  shouldSkipPayment,
} from "./payment-service";
import { mapCountryCode, normalizePostalCode } from "./consumer";

const p2mData = {
  order_reference: "TKW2BRL2OP",
  client_uuid: "94d15bf3-1111-2222-3333-444455556666",
  invoice_number: "NULF-CT:cart_1",
  autoship_reference: "G2XYS6ZBBZ",
  from_account_name: "Emma Stone",
};

const billingAddress = {
  address1: "123 California Ave",
  city: "Santa Monica",
  state: "CA",
  country_code: "US",
  postal_code: "90403",
};

describe("normalizePaymentType", () => {
  it("maps uwallet to p2m, which is what Freedom labels 'UWallet'", () => {
    expect(normalizePaymentType("uwallet")).toBe("p2m");
    expect(normalizePaymentType("UWALLET")).toBe("p2m");
  });

  it("lowercases everything else", () => {
    expect(normalizePaymentType("LOAD_FUNDS_VIA_CARD")).toBe(
      "load_funds_via_card",
    );
  });
});

describe("buildPaymentPayload", () => {
  it("sends no ProcessorSpecificDetail23", () => {
    // Removed in 6fe8ea2: ByDesign maps Detail3 to detail23 in its own database
    // (offset by 20), so Detail23 was both redundant and not a valid API field.
    const payload = buildPaymentPayload({
      orderId: "12345",
      payment: { id: "PAY_A", type: "uwallet", amount: "878.00", status: "Success" },
      p2mData,
      billingAddress,
      kycStatus: "APPROVE",
    });

    expect("ProcessorSpecificDetail23" in payload).toBe(false);
    expect(payload.ProcessorSpecificDetail3).toBe("p2m");
  });

  it("carries the identifiers ByDesign reconciles on", () => {
    const payload = buildPaymentPayload({
      orderId: "12345",
      payment: {
        id: "EZC1236EQI",
        type: "uwallet",
        amount: "878.00",
        status: "Success",
      },
      p2mData,
      billingAddress,
      kycStatus: "APPROVE",
    });

    expect(payload.OrderID).toBe(12345);
    expect(payload.TransactionID).toBe("TKW2BRL2OP");
    // The receipt key, and the only per-payment identifier ByDesign is given.
    expect(payload.ReferenceNumber).toBe("EZC1236EQI");
    expect(payload.PersistentToken).toBe(p2mData.client_uuid);
    expect(payload.ProfileIDUsedForProcessor).toBe(p2mData.client_uuid);
    expect(payload.ProcessorSpecificDetail1).toBe("NULF-CT:cart_1");
    expect(payload.ProcessorSpecificDetail2).toBe("G2XYS6ZBBZ");
    expect(payload.ProcessorSpecificDetail4).toBe("TKW2BRL2OP");
  });

  it("prefers a payment line's own order_reference over the root one", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", order_reference: "LINE_REF", status: "Success" },
      p2mData,
    });

    expect(payload.TransactionID).toBe("LINE_REF");
  });

  it("puts a Success amount in Amount and leaves PromissoryAmount at zero", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", type: "uwallet", amount: "878.00", status: "Success" },
      kycStatus: "APPROVE",
    });

    expect(payload.Amount).toBe(878);
    expect(payload.PromissoryAmount).toBe(0);
    expect(payload.PaymentStatusTypeID).toBe(1);
  });

  it("puts a CASH amount in PromissoryAmount, whatever the line status says", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: {
        id: "a",
        type: "LOAD_FUNDS_VIA_CASH",
        amount: "50.00",
        status: "Success",
      },
      kycStatus: "APPROVE",
    });

    expect(payload.Amount).toBe(0);
    expect(payload.PromissoryAmount).toBe(50);
    expect(payload.PaymentStatusTypeID).toBe(6);
  });

  it("lets KYC REVIEW override an otherwise successful line", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", type: "uwallet", amount: "10", status: "Success" },
      kycStatus: "REVIEW",
    });

    expect(payload.PaymentStatusTypeID).toBe(6);
    expect(payload.Amount).toBe(0);
    expect(payload.PromissoryAmount).toBe(10);
  });

  it("adds card fields only for card payments", () => {
    const cardDetails = {
      payment_instrument_uuid: "pi_1",
      card_number_last4: "7999",
      expiry_date: "8/2029",
    };

    const card = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", type: "LOAD_FUNDS_VIA_CARD", amount: "10", status: "Success" },
      cardDetails,
      kycStatus: "APPROVE",
    });
    expect(card.PaymentToken).toBe("pi_1");
    expect(card.Last4CCNumber).toBe("7999");
    expect(card.ExpirationDateMMYY).toBe("0829");

    const wallet = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", type: "uwallet", amount: "10", status: "Success" },
      cardDetails,
      kycStatus: "APPROVE",
    });
    expect("Last4CCNumber" in wallet).toBe(false);
    expect("ExpirationDateMMYY" in wallet).toBe(false);
  });

  it("prefers Moola's from_account_name for the cardholder", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", status: "Success" },
      p2mData,
      billingAddress: { ...billingAddress, name: "Someone Else" },
    });

    expect(payload.CardHolderName).toBe("Emma Stone");
  });

  it("falls back to first + last name when neither other source has one", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", status: "Success" },
      billingAddress: { first_name: "ezequiel", last_name: "Mastantuono" },
    });

    expect(payload.CardHolderName).toBe("ezequiel Mastantuono");
  });

  it("sends the ByDesign country NAME, not the ISO code", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", status: "Success" },
      billingAddress,
    });

    expect(payload.Country).toBe("USA");
  });

  it("omits Address2 rather than sending null", () => {
    const payload = buildPaymentPayload({
      orderId: "1",
      payment: { id: "a", status: "Success" },
      billingAddress,
    });

    expect("Address2" in payload).toBe(false);
  });
});

describe("determineEffectiveStatus", () => {
  it("defaults an unknown line status to Pending rather than Success", () => {
    expect(
      determineEffectiveStatus({ id: "a", status: "Whatever" }, "APPROVE"),
    ).toBe(6);
    expect(determineEffectiveStatus({ id: "a" }, "APPROVE")).toBe(6);
  });

  it("lets APPROVE fall through to the line's own status", () => {
    expect(
      determineEffectiveStatus({ id: "a", status: "Success" }, "APPROVE"),
    ).toBe(1);
  });

  it("maps DECLINE to 18", () => {
    expect(
      determineEffectiveStatus({ id: "a", status: "Success" }, "DECLINE"),
    ).toBe(18);
  });
});

describe("amounts", () => {
  it("treats a non-numeric amount as zero rather than NaN", () => {
    const payment = { id: "a", type: "uwallet", amount: "abc", status: "Success" };
    expect(calculateAmount(payment, "APPROVE")).toBe(0);
    expect(calculatePromissoryAmount(payment, "APPROVE")).toBe(0);
  });
});

describe("paymentDate", () => {
  it("emits exactly what Ruby emits, offset spelling included", () => {
    // Measured, not assumed:
    //   TZ=UTC ruby -rtime -e 'puts Time.at(1767187441840/1000).iso8601'
    //   => 2025-12-31T13:24:01+00:00
    // JavaScript's `toISOString()` would give "2025-12-31T13:24:01.000Z" —
    // different in TWO ways, on a field a payment processor parses, on every
    // Save.
    expect(paymentDate({ completed_at: "1767187441840" })).toBe(
      "2025-12-31T13:24:01+00:00",
    );
  });

  it("falls back to now, in the same spelling", () => {
    const now = new Date("2026-05-05T00:00:00.123Z");
    expect(paymentDate({}, now)).toBe("2026-05-05T00:00:00+00:00");
    expect(paymentDate({ completed_at: "not a number" }, now)).toBe(
      "2026-05-05T00:00:00+00:00",
    );
  });
});

describe("card detail extraction", () => {
  it("prefers card_number_last4 and falls back to last4", () => {
    expect(extractLast4({ card_number_last4: "7999" })).toBe("7999");
    expect(extractLast4({ last4: "1234" })).toBe("1234");
    expect(extractLast4({})).toBeNull();
  });

  it("formats an expiry from either shape", () => {
    expect(extractExpiry({ expiry_date: "8/2029" })).toBe("0829");
    expect(extractExpiry({ expiry_date: "08/29" })).toBe("0829");
    expect(extractExpiry({ expiry_month: 8, expiry_year: 2029 })).toBe("0829");
    expect(extractExpiry({ expiry_date: "garbage" })).toBeNull();
    expect(extractExpiry({})).toBeNull();
  });
});

describe("shouldSkipPayment", () => {
  it("skips only Declined", () => {
    expect(shouldSkipPayment({ id: "a", status: "Declined" })).toBe(true);
    expect(shouldSkipPayment({ id: "a", status: "Pending" })).toBe(false);
    expect(shouldSkipPayment({ id: "a" })).toBe(false);
  });
});

describe("address normalisation shared with the consumer API", () => {
  it("strips spaces from a Canadian postal code", () => {
    expect(normalizePostalCode("V9R 5G1")).toBe("V9R5G1");
    expect(normalizePostalCode("")).toBe("");
    expect(normalizePostalCode(null)).toBeNull();
  });

  it("maps the ByDesign special cases", () => {
    expect(mapCountryCode("KR")).toBe("KOREA (THE REPUBLIC OF)");
    expect(mapCountryCode("CN")).toBe("CHINA");
    expect(mapCountryCode("ca")).toBe("CANADA");
    // Unknown codes pass through rather than becoming null.
    expect(mapCountryCode("ZZ")).toBe("ZZ");
  });
});
