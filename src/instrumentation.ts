/**
 * Next.js calls this once when the server starts.
 *
 * Its only job here is to say out loud whether this droplet can actually verify
 * the callbacks it is about to be sent.
 *
 * That question has no other answer. `redirect_cart_payment` is
 * checkout-blocking, so every refusal — a missing token, an unknown digest, an
 * unreadable store — answers 200 with the neutral
 * `{redirect_url: null, error_message: ...}` body, which is a shape the
 * definition explicitly allows. An installation with no stored registrations is
 * therefore indistinguishable, from outside, from a droplet that simply could
 * not open a uPayments order: no status code changes, no error rate moves,
 * nothing alerts. The boot log line is the signal.
 *
 * This droplet has never held a callback token — registration was a hand-run
 * curl that discarded the one the create response issued — so on the first
 * deploy this check is EXPECTED to report zero, and it must report non-zero
 * before the callback is repointed here. See CUTOVER.md.
 *
 * Never throws and never prevents boot: a droplet that cannot reach its database
 * during boot has a larger problem than this check, and turning a warning into a
 * crash loop would be its own outage.
 */
export async function register(): Promise<void> {
  // An `if`, not an early return, and this matters. `instrumentation.ts` is
  // compiled once per runtime, and this repo has middleware, so it is also
  // compiled for edge. Next replaces `process.env.NEXT_RUNTIME` with a literal
  // in each compilation, which lets webpack drop this whole branch — and with
  // it the SDK import below — from the edge bundle. Guarding with an early
  // return instead leaves the import reachable, and the edge compiler then
  // fails on the `node:crypto` that `signatures.ts` needs.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Deliberately NOT awaited. Next awaits `register()` before it serves, and
    // this check is advisory — it changes nothing about how a request is
    // handled. It also retries across minutes rather than seconds, because on a
    // cold start the first query competes with the rest of boot for a throttled
    // CPU and a pool connection. Awaiting it would hold the cold start open for
    // that whole span, in front of the first callback, which is the one moment
    // this droplet can least afford the delay. It reports when it reports.
    void (async () => {
      const { reportCallbackVerificationReadiness } = await import(
        "@fluid-app/droplet-sdk"
      );
      const { prisma } = await import("@/lib/db");

      await reportCallbackVerificationReadiness({
        countRegistrations: () => prisma.fluidCallbackRegistration.count(),
        backfillCommand: "pnpm backfill:callbacks",
      });
    })();
  }
}
