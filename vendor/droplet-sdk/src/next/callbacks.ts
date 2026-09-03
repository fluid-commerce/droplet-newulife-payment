import {
  tokenDigest,
  verifySignature,
  type SignatureFailureReason,
} from "../signatures";
import { consoleLogger, describeError, type Logger } from "../redact";
import type { CallbackTokenStore, StoredRegistration } from "../store/types";

export const HEADER_TIMESTAMP = "x-fluid-timestamp";
export const HEADER_SIGNATURE = "x-fluid-signature";
export const HEADER_CALLBACK_TOKEN = "x-fluid-callback-token";

export interface CallbackContext<Principal> {
  /** Parsed body. Only reached after the signature verified. */
  payload: unknown;
  /** Which of the configured definitions this registration serves. */
  definition: string;
  /** App-resolved tenant. Trustworthy; do not re-derive from payload. */
  principal: Principal;
  /**
   * The registration whose token verified this request.
   *
   * Never null: every path that leaves it unresolved returns before the handler
   * runs.
   */
  registration: StoredRegistration;
  /** The body stream is consumed by the wrapper, so these are passed explicitly. */
  headers: Headers;
  signal: AbortSignal;
  rawBody: string;
}

export interface CallbackFailure {
  stage: "auth" | "body" | "handler";
  reason: string;
  /** Present only for handler failures. */
  error?: unknown;
}

export interface WithFluidCallbackConfig<Principal> {
  /**
   * Definition names this route serves.
   *
   * An array because one route legitimately serves several — a single
   * cart-item-changed handler may be registered under five definitions. A token
   * issued for a definition this route does not serve is rejected.
   */
  definitions: string[];
  store: CallbackTokenStore;
  /**
   * Resolves the tenant *after* the signature verifies.
   *
   * Returning null is treated as an auth failure — an authenticated
   * registration whose tenant cannot be resolved is not safe to run.
   */
  resolvePrincipal: (input: {
    registration: StoredRegistration;
    payload: unknown;
    headers: Headers;
  }) => Promise<Principal | null>;

  logger?: Logger;
  /** Label used in log lines. Defaults to the first definition. */
  name?: string;

  /**
   * Failure policy. Defaults fail closed with 401/400/500.
   *
   * Routes on the checkout path must override these — a tax droplet answers a
   * failed calculation with a zero-tax object, and returning a 401 there would
   * break the cart rather than protect it.
   */
  onAuthFailure?: (failure: CallbackFailure) => Response;
  onInvalidBody?: (failure: CallbackFailure) => Response;
  onHandlerError?: (failure: CallbackFailure) => Response;
}

export type CallbackHandler<Principal> = (
  context: CallbackContext<Principal>,
) => Promise<Response | unknown>;

const denyAuth = () =>
  Response.json({ error: "unauthorized" }, { status: 401 });
const denyBody = () =>
  Response.json({ error: "invalid request" }, { status: 400 });
const denyHandler = () =>
  Response.json({ error: "internal error" }, { status: 500 });

/**
 * Wraps a Fluid callback route with signature verification.
 *
 * Order of operations matters and is the reason this wrapper exists:
 *
 *   1. read the raw body (the exact bytes Fluid signed)
 *   2. locate the registration by digest of the presented token
 *   3. verify the signature against the *stored* registration
 *   4. only then parse, resolve the tenant, and run the handler
 *
 * Step 1 is why every route cannot simply keep calling `request.json()`:
 * re-serialising a parsed object does not reliably reproduce the signed bytes.
 */
export function withFluidCallback<Principal>(
  config: WithFluidCallbackConfig<Principal>,
  handler: CallbackHandler<Principal>,
) {
  const {
    definitions,
    store,
    resolvePrincipal,
    logger = consoleLogger,
    name = definitions[0] ?? "callback",
    onAuthFailure = denyAuth,
    onInvalidBody = denyBody,
    onHandlerError = denyHandler,
  } = config;

  if (definitions.length === 0) {
    throw new Error("withFluidCallback requires at least one definition");
  }

  return async function POST(request: Request): Promise<Response> {
    const log = (
      level: "warn" | "error",
      message: string,
      context: Record<string, unknown> = {},
    ) => logger[level](`[fluid-callback:${name}] ${message}`, context);

    // Read BYTES, not text. `request.text()` runs a UTF-8 decode, which is not
    // a round trip: it strips a leading BOM and replaces malformed sequences
    // with U+FFFD. Re-encoding that to verify would hash something Fluid never
    // sent, and the mismatch would look like a forged request.
    //
    // The handler still receives a decoded string, since that is what every
    // route wants; only the HMAC uses the original bytes.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.arrayBuffer());
    } catch (error) {
      log("error", "could not read request body", describeError(error));
      return onInvalidBody({ stage: "body", reason: "unreadable" });
    }
    const rawBody = new TextDecoder().decode(bodyBytes);

    const presentedToken = request.headers.get(HEADER_CALLBACK_TOKEN);
    let registration: StoredRegistration | null = null;
    let authFailure: SignatureFailureReason | string | null = null;

    if (!presentedToken) {
      authFailure = "missing_callback_token";
    } else {
      try {
        registration = await store.findByTokenDigest(
          tokenDigest(presentedToken),
        );
      } catch (error) {
        // A store outage must not escape as an unhandled rejection, and must
        // not be treated as "unverified but probably fine". A missing table —
        // the shape of deploying before the migration runs — leaves the rest of
        // the database perfectly readable, so this is an ordinary failure mode
        // rather than an attack.
        //
        // It fails closed through the route's own policy, so a fail-open tax
        // route still answers with its zero-tax object rather than a 500.
        log("error", "token store lookup failed", describeError(error));
        return onAuthFailure({ stage: "auth", reason: "store_unavailable" });
      }

      if (!registration) {
        // Deliberately does not log the token, even on a miss.
        authFailure = "unknown_registration";
      } else if (!definitions.includes(registration.definitionName)) {
        // Stops a token issued for one definition being replayed at another
        // route. Checked before the signature only because it needs no crypto;
        // both outcomes are a rejection.
        authFailure = "definition_mismatch";
      } else {
        const result = verifySignature({
          rawBody: bodyBytes,
          signature: request.headers.get(HEADER_SIGNATURE),
          timestamp: request.headers.get(HEADER_TIMESTAMP),
          // The presented token, whose digest matched what we stored. The stored
          // digest is not usable as an HMAC key, which is the point of storing it.
          secret: presentedToken,
        });
        if (!result.valid) authFailure = result.reason;
      }
    }

    // Every unverified request is refused, through the route's own failure
    // policy. There is no tolerated case.
    //
    // Earlier revisions had an `observe` mode that ran the handler for requests
    // it could not verify, resolving the tenant from the payload instead. It
    // existed because a droplet has no verification tokens until they are
    // copied out of Fluid, so switching verification on at the same moment
    // would have rejected all genuine traffic.
    //
    // Every attempt to decide automatically when that tolerance could end was
    // wrong in one direction or the other: keying on "did we find a token for
    // this request" let the caller opt into tolerance by omitting the token,
    // and keying on "does this route have tokens stored" flipped for the whole
    // fleet as soon as the first installation was migrated, silently rejecting
    // every other one. The question cannot be answered per request.
    //
    // So it is answered by the rollout instead: copy the tokens first, confirm
    // they arrived, then deploy this. See the migration section of the README.
    if (authFailure) {
      log("warn", "rejected", { reason: authFailure });
      return onAuthFailure({ stage: "auth", reason: authFailure });
    }

    // Unreachable: every path that leaves `registration` unset also set
    // `authFailure` and returned above. Kept as a guard rather than a `!` so
    // that if that ever stops being true, the route fails closed instead of
    // handing a handler an undefined tenant.
    if (!registration) {
      log("error", "no registration after verification passed");
      return onAuthFailure({ stage: "auth", reason: "unknown_registration" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      log("warn", "body was not valid JSON");
      return onInvalidBody({ stage: "body", reason: "malformed_json" });
    }

    let principal: Principal | null = null;
    try {
      // `registration` is non-null here: every path that leaves it null has
      // already returned above.
      principal = await resolvePrincipal({
        registration,
        payload,
        headers: request.headers,
      });
    } catch (error) {
      log("error", "principal resolution threw", describeError(error));
      return onHandlerError({
        stage: "handler",
        reason: "resolve_threw",
        error,
      });
    }

    if (principal === null) {
      // Fail closed in this wrapper: a handler cannot run without a tenant, and
      // guessing one would be worse than declining.
      log("warn", "rejected", {
        reason: "unresolved_principal",
      });
      return onAuthFailure({ stage: "auth", reason: "unresolved_principal" });
    }

    try {
      const result = await handler({
        payload,
        definition: registration.definitionName,
        principal,
        registration,
        headers: request.headers,
        signal: request.signal,
        rawBody,
      });
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      // The body is never included here. That is the whole point.
      log("error", "handler threw", describeError(error));
      return onHandlerError({
        stage: "handler",
        reason: "handler_threw",
        error,
      });
    }
  };
}
