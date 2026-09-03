/*
 * IMPLEMENTATION NOTES — not JSDoc. This file's module comment would be emitted
 * into the published `.d.ts`, and the failure it describes is a map of how to
 * exploit a droplet mid-rollout. Keep that here; keep the exported doc comments
 * to what a consumer needs.
 *
 * The routes verify every request against stored registration tokens, and those
 * rows come from a backfill run by hand between deploys. If the backfill is
 * skipped, or run against the wrong database, the table is empty and every live
 * callback is refused — with a 200 and a neutral body, because Fluid blocks a
 * checkout on this response. Fluid sees success. No error rate moves. Nobody
 * finds out. So the ordering is not left to a sentence in a PR description: the
 * droplet says on startup whether it is in that state.
 *
 * It never throws and never prevents boot. A droplet that cannot reach its
 * database at boot has a bigger problem than this check, and turning a warning
 * into a crash loop would be its own outage.
 */

/**
 * Boot-time check that this droplet can verify callbacks.
 *
 * Reports whether any registration tokens are stored yet. Until they are, a
 * wrapped route cannot verify anything it receives.
 *
 * Never throws and never prevents boot.
 *
 * CALLING CONTRACT: do not await this from `instrumentation.register()`. It
 * retries for minutes rather than seconds before giving up, so awaiting it
 * would hold a cold start open for that whole span.
 */

export type CallbackVerificationReadiness =
  | "ready"
  | "no-registrations"
  | "unavailable";

const MARKER = "[fluid-callback:readiness]";

/**
 * Bounds a single attempt. Generous, because this races a Cloud Run cold start
 * where the first query also pays for TCP setup, TLS and the Cloud SQL
 * connector handshake while competing with the rest of boot for a throttled
 * CPU.
 *
 * Note what this bound can and cannot buy. Raising it was tried twice — 5s,
 * then 20s — and the check still reported `unavailable` on healthy droplets,
 * because the contention it loses to is not a slow query. It is boot itself:
 * with min-instances set, a deploy starts several instances at once and they
 * all reach for a connection at the same moment, so the pool checkout — not
 * the COUNT — is what runs out of time. A budget cannot outrun that; it can
 * only make boot's first minute quieter or noisier. Hence the retry below.
 */
const TIMEOUT_MS = 20_000;

/**
 * Waits between attempts, and the actual fix.
 *
 * The proof that retrying is the right lever rather than waiting longer once:
 * this check has been observed timing out twice in consecutive minutes while,
 * twenty minutes later, a live callback read from that same database and
 * answered normally. The database was never unreachable. Only the boot-time
 * moment was.
 *
 * So the attempts are spread across the minutes after boot rather than packed
 * into it, and `unavailable` is reported only once every one of them has
 * failed — which is the state the check was written to report, and which these
 * delays make it mean again. Nothing here is on a request path: this is fired
 * detached and its answer is a log line, so spending minutes is free.
 */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

type Logger = Pick<Console, "error" | "info">;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fake-timer friendly: the tests advance these rather than waiting. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reportCallbackVerificationReadiness({
  countRegistrations,
  backfillCommand,
  logger = console,
}: {
  countRegistrations: () => Promise<number>;
  /**
   * The exact command an operator should run to fix an empty table, e.g.
   * `pnpm --filter <droplet> backfill:callbacks`. Named rather than derived,
   * because the alert is read by someone who does not already know which
   * droplet is broken.
   */
  backfillCommand: string;
  logger?: Logger;
}): Promise<CallbackVerificationReadiness> {
  const attempts = RETRY_DELAYS_MS.length + 1;
  let lastError = "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);

    let count: number;
    try {
      count = await withTimeout(countRegistrations(), TIMEOUT_MS);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Info, not error: a single failed attempt says nothing yet, and this is
      // the log line that used to page someone for a healthy droplet. The trail
      // is still here for anyone reading the boot sequence afterwards.
      logger.info(
        `${MARKER} could not read stored callback registrations yet; retrying`,
        { attempt: attempt + 1, of: attempts, error: lastError },
      );
      continue;
    }

    // Both outcomes below are answers, so neither retries.
    if (count === 0) {
      logger.error(
        `${MARKER} NO callback registrations are stored, but callback ` +
          `verification is enabled. Every callback Fluid sends will be refused, ` +
          `and refusals answer 200 so nothing else will report this. Run ` +
          `\`${backfillCommand}\` against this database.`,
      );
      return "no-registrations";
    }

    logger.info(`${MARKER} verifying callbacks against stored registrations`, {
      registrations: count,
      ...(attempt > 0 ? { afterAttempts: attempt + 1 } : {}),
    });
    return "ready";
  }

  // Every attempt spent, spread over minutes rather than one boot instant.
  // This now means what it says.
  logger.error(
    `${MARKER} could not check stored callback registrations after ` +
      `${attempts} attempts; cannot tell whether verification will accept ` +
      `anything`,
    { error: lastError },
  );
  return "unavailable";
}
