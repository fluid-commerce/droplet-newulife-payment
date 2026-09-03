/**
 * Leg ③ — the Moola / uPayments payment webhook.
 *
 * Port of `MoolaWebhooksController#p2m`, at THE SAME PATH.
 *
 * The path is deliberately unchanged from Rails (`POST /webhooks/moola/p2m`).
 * This webhook's url lives on Moola's side, not Fluid's, so repointing it is a
 * third-party change with its own lead time. Keeping the path identical makes
 * that change host-only. Contrast the Fluid webhook, which moves from
 * `POST /webhook` to `POST /api/webhooks` because Fluid holds that url and this
 * droplet can move it itself.
 *
 * ## This one fails CLOSED, and that is not an inconsistency
 *
 * The callback route answers 200 on every failure because a refusal there is a
 * broken cart. This is the opposite: Moola retries a non-2xx, so refusing
 * loudly is free, and accepting an unverified payment notification is not — the
 * payload flows straight into the ByDesign recording path.
 *
 *   401 — bad or missing signature
 *   400 — unparseable JSON
 *   500 — anything else, so Moola re-sends
 *   202 — accepted
 *
 * ## The signature check is UNCONDITIONAL here
 *
 * This is the one deliberate behaviour change on the money path. Rails runs it
 * `if: :signature_verification_enabled?`, which is true only when
 * MOOLA_WEBHOOK_SECRET is set — so an unset secret makes the endpoint accept
 * anything, and an unauthenticated caller can post a crafted
 * `invoice_number: "NULF-CT:<cart_token>"` with arbitrary `payment_details`.
 * `MOOLA_WEBHOOK_SECRET` appears nowhere in this repository outside that
 * controller, in no deploy artefact, and not in
 * docs/gcp-environment-variables.md.
 *
 * Fail-open-when-unconfigured is not a behaviour worth porting, so it is not
 * ported. Setting the secret on both sides is a prerequisite for cutting this
 * leg over — see CUTOVER.md.
 *
 * ## At-least-once
 *
 * Moola re-sends, and this droplet has already been bitten by that: a second
 * delivery for an already-recorded cart used to regress the ledger row's status
 * and record every payment to ByDesign again. The guards live in
 * src/lib/payments/moola-webhook.ts; this route just gets the bytes there.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { processMoolaWebhook } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Rails accepted `X-Moola-Signature` OR `X-Webhook-Signature`, with no recorded
 * reason. Both are kept — the sender's configuration is not visible from here
 * and dropping one could silently reject every delivery — but they are read in
 * a fixed order and only one is ever compared.
 */
const SIGNATURE_HEADERS = ["x-moola-signature", "x-webhook-signature"];

function verify(rawBody: string, presented: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // Validate the shape before parsing: `Buffer.from(s, "hex")` truncates at the
  // first invalid character rather than throwing, so a valid prefix followed by
  // junk would otherwise compare equal to the valid prefix.
  if (presented.length !== expected.length || !/^[0-9a-fA-F]+$/.test(presented)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(presented, "hex"),
    Buffer.from(expected, "hex"),
  );
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.MOOLA_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than accept. A 500 makes Moola retry, so a secret set a
    // minute later recovers the delivery — where accepting would have written
    // an unverified payment into the ledger permanently.
    console.error(
      "[MoolaWebhook] MOOLA_WEBHOOK_SECRET is not set; refusing every delivery",
    );
    return new NextResponse(null, { status: 500 });
  }

  const presented = SIGNATURE_HEADERS.map((header) =>
    request.headers.get(header),
  ).find((value): value is string => !!value);

  if (!presented) {
    console.warn("[MoolaWebhook] Missing webhook signature header");
    return new NextResponse(null, { status: 401 });
  }

  // Raw text, not `request.json()`: the HMAC is over the bytes Moola sent, and
  // re-serialising a parsed object does not reproduce them.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (!verify(rawBody, presented, secret)) {
    console.warn("[MoolaWebhook] Invalid webhook signature");
    return new NextResponse(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("[MoolaWebhook] JSON parse error");
    return new NextResponse(null, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new NextResponse(null, { status: 400 });
  }

  try {
    // Rails enqueued a job and answered 202 immediately. This runs inline and
    // then answers, so a failure is a 500 Moola will retry rather than a 202
    // followed by silence. The work is a handful of writes plus, at most, the
    // ByDesign recording for one cart.
    //
    // The payload is never logged. Rails logged a redacted copy — good — but
    // then passed the UNREDACTED body to the job, where Solid Queue stored it
    // in a table an admin UI renders. Nothing here logs it at all; the raw body
    // still lands in `moola_payments.moola_webhook_payload`, as it does today.
    const outcome = await processMoolaWebhook(
      payload as Record<string, unknown>,
    );
    console.log(`[MoolaWebhook] ${outcome.reason}`);

    // THE DELIVERY IS THE RETRY. This app has no queue, so a recording run that
    // failed transiently has nothing to come back for it — Rails had
    // `retry_on StandardError, attempts: 5` on the job and this does not.
    // Answering 5xx makes Moola re-deliver, which re-enters the same code path
    // and re-drives the run. Safe only because `bydesign_payment_receipts`
    // makes a re-run idempotent; without it this would re-Save the lines that
    // already landed. Bounded by MAX_RECORDING_ATTEMPTS, after which the row is
    // terminal and `recordingNeedsRetry` is false.
    if (outcome.recordingNeedsRetry) {
      console.error(
        "[MoolaWebhook] Recording did not complete; answering 5xx so Moola re-delivers",
      );
      return new NextResponse(null, { status: 503 });
    }

    return new NextResponse(null, { status: 202 });
  } catch (error) {
    console.error(
      "[MoolaWebhook] Error processing P2M webhook:",
      error instanceof Error ? error.message : error,
    );
    return new NextResponse(null, { status: 500 });
  }
}
