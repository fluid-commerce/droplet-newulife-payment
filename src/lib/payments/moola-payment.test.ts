/**
 * The ledger row's own logic.
 *
 * The first block is the regression test for the duplicate-recording bug fixed
 * in 6fe8ea2 / 6afa536. It is the reason this file exists: delete the terminal
 * guard from `determineStatus` and these fail, which is the property a
 * regression test has to have.
 */

import { describe, it, expect } from "vitest";

import {
  determineStatus,
  extractCartToken,
  formatInvoiceNumber,
  kycApproved,
  maxAttemptsReached,
  moolaDataPresent,
  readyToRecord,
  shouldPostOrder,
  type LedgerState,
} from "./moola-payment";
import { isTerminal, MOOLA_PAYMENT_STATUS, statusName } from "./types";

/** A row that has everything the recording path waits for. */
function completeState(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    status: MOOLA_PAYMENT_STATUS.pending,
    kycStatus: "APPROVE",
    bydesignOrderId: "12345",
    paymentDetails: [
      { id: "EZC1236EQI", type: "uwallet", amount: "100", status: "Success" },
    ],
    ...overrides,
  };
}

describe("determineStatus — the terminal-state invariant", () => {
  // THE bug. `determine_status` used to return :matched whenever the data
  // looked complete. A second Moola delivery for an already-recorded cart
  // therefore regressed :recorded -> :matched, sailed past the enqueue guard,
  // and recorded every payment to ByDesign a second time. Webhook delivery is
  // at-least-once, so that second delivery is routine.
  //
  // Note the state below is COMPLETE: without the guard the answer is `matched`,
  // not `recorded`. A test built on incomplete data would pass either way and
  // prove nothing.
  it("keeps `recorded` even when every precondition for `matched` is met", () => {
    const state = completeState({ status: MOOLA_PAYMENT_STATUS.recorded });

    expect(readyToRecord({ ...state, status: MOOLA_PAYMENT_STATUS.matched }))
      .toBe(true);
    expect(determineStatus(state)).toBe(MOOLA_PAYMENT_STATUS.recorded);
  });

  it("keeps `failed` even when every precondition for `matched` is met", () => {
    const state = completeState({ status: MOOLA_PAYMENT_STATUS.failed });
    expect(determineStatus(state)).toBe(MOOLA_PAYMENT_STATUS.failed);
  });

  it("keeps `recording` so a run in flight is not interfered with", () => {
    const state = completeState({ status: MOOLA_PAYMENT_STATUS.recording });
    expect(determineStatus(state)).toBe(MOOLA_PAYMENT_STATUS.recording);
  });

  it("does not treat a terminal status as re-runnable", () => {
    expect(isTerminal(MOOLA_PAYMENT_STATUS.recorded)).toBe(true);
    expect(isTerminal(MOOLA_PAYMENT_STATUS.failed)).toBe(true);
    // `recording` is a claim, not a terminal state: a stale claim is reclaimed.
    expect(isTerminal(MOOLA_PAYMENT_STATUS.recording)).toBe(false);
    expect(isTerminal(MOOLA_PAYMENT_STATUS.matched)).toBe(false);
    expect(isTerminal(MOOLA_PAYMENT_STATUS.pending)).toBe(false);
  });

  it("still promotes a NON-terminal row, so the guard is not just 'never move'", () => {
    // The counterweight to the four tests above: if `determineStatus` were
    // stubbed to return its input status unconditionally, they would all pass
    // and nothing would ever record.
    expect(determineStatus(completeState())).toBe(MOOLA_PAYMENT_STATUS.matched);
  });
});

describe("determineStatus — the ordinary transitions", () => {
  it("KYC DECLINE outranks a complete row", () => {
    expect(determineStatus(completeState({ kycStatus: "DECLINE" }))).toBe(
      MOOLA_PAYMENT_STATUS.kyc_declined,
    );
  });

  it("KYC REVIEW outranks a complete row", () => {
    expect(determineStatus(completeState({ kycStatus: "REVIEW" }))).toBe(
      MOOLA_PAYMENT_STATUS.kyc_pending,
    );
  });

  it("stays pending without a ByDesign order id", () => {
    expect(determineStatus(completeState({ bydesignOrderId: null }))).toBe(
      MOOLA_PAYMENT_STATUS.pending,
    );
  });

  it("stays pending without payment details", () => {
    expect(determineStatus(completeState({ paymentDetails: [] }))).toBe(
      MOOLA_PAYMENT_STATUS.pending,
    );
  });

  it("stays pending when KYC has not answered at all", () => {
    expect(determineStatus(completeState({ kycStatus: null }))).toBe(
      MOOLA_PAYMENT_STATUS.pending,
    );
  });
});

describe("readyToRecord", () => {
  it("is true only from `matched`", () => {
    const matched = completeState({ status: MOOLA_PAYMENT_STATUS.matched });
    expect(readyToRecord(matched)).toBe(true);
    expect(readyToRecord({ ...matched, status: MOOLA_PAYMENT_STATUS.pending }))
      .toBe(false);
    expect(readyToRecord({ ...matched, status: MOOLA_PAYMENT_STATUS.recorded }))
      .toBe(false);
    expect(readyToRecord({ ...matched, status: MOOLA_PAYMENT_STATUS.recording }))
      .toBe(false);
  });
});

describe("shouldPostOrder", () => {
  const base = completeState({ status: MOOLA_PAYMENT_STATUS.recorded });

  it("posts when KYC is approved and every line succeeded", () => {
    expect(shouldPostOrder(base)).toBe(true);
  });

  it("refuses when any line is cash — the order stays Entered until it arrives", () => {
    expect(
      shouldPostOrder({
        ...base,
        paymentDetails: [
          { id: "a", type: "uwallet", status: "Success" },
          { id: "b", type: "LOAD_FUNDS_VIA_CASH", status: "Success" },
        ],
      }),
    ).toBe(false);
  });

  it("refuses when a line is still Pending", () => {
    expect(
      shouldPostOrder({
        ...base,
        paymentDetails: [{ id: "a", type: "uwallet", status: "Pending" }],
      }),
    ).toBe(false);
  });

  it("refuses when KYC is not APPROVE", () => {
    expect(shouldPostOrder({ ...base, kycStatus: "REVIEW" })).toBe(false);
  });

  it("refuses when there are no lines at all", () => {
    expect(shouldPostOrder({ ...base, paymentDetails: [] })).toBe(false);
  });
});

describe("invoice numbers", () => {
  it("round-trips a cart token", () => {
    expect(formatInvoiceNumber("abc123")).toBe("NULF-CT:abc123");
    expect(extractCartToken("NULF-CT:abc123")).toBe("abc123");
  });

  it("round-trips a cart token containing a colon", () => {
    // The Ruby regex is `^NULF-CT:(.+)$` — greedy and anchored — so the whole
    // remainder is the token.
    expect(extractCartToken("NULF-CT:a:b")).toBe("a:b");
  });

  it("returns null for anything that is not one of ours", () => {
    expect(extractCartToken("OTHER:abc")).toBeNull();
    expect(extractCartToken("NULF-CT:")).toBeNull();
    expect(extractCartToken("")).toBeNull();
    expect(extractCartToken(null)).toBeNull();
  });
});

describe("small predicates", () => {
  it("moolaDataPresent is about lines, not about the column existing", () => {
    expect(moolaDataPresent(completeState({ paymentDetails: [] }))).toBe(false);
    expect(moolaDataPresent(completeState())).toBe(true);
  });

  it("kycApproved is exact", () => {
    expect(kycApproved(completeState({ kycStatus: "APPROVE" }))).toBe(true);
    expect(kycApproved(completeState({ kycStatus: "approve" }))).toBe(false);
  });

  it("maxAttemptsReached matches MoolaPayment::MAX_RECORDING_ATTEMPTS", () => {
    expect(maxAttemptsReached(4)).toBe(false);
    expect(maxAttemptsReached(5)).toBe(true);
    expect(maxAttemptsReached(null)).toBe(false);
  });

  it("names every status, so a log line never prints a bare integer", () => {
    for (const [name, value] of Object.entries(MOOLA_PAYMENT_STATUS)) {
      expect(statusName(value)).toBe(name);
    }
  });
});
