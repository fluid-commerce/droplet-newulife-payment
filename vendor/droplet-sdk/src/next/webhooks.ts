import { verifySignature } from "../signatures";
import { consoleLogger, describeError, type Logger } from "../redact";

export const HEADER_TIMESTAMP = "x-fluid-timestamp";
export const HEADER_SIGNATURE = "x-fluid-signature";
export const HEADER_SHOP = "x-fluid-shop";

/**
 * The event that arrives before any per-company secret exists, and so the
 * default — and only sensible — member of `bootstrapEvents`.
 */
export const INSTALL_EVENT = "droplet.installed";

export interface WebhookRoutingHints {
  /** Parsed but *unverified*. Used only to locate a candidate secret. */
  payload: unknown;
  headers: Headers;
  dri?: string;
  fluidShop?: string;
  companyId?: string | number;
}

export interface ResolvedWebhookPrincipal<Principal> {
  secret: string;
  principal: Principal;
}

export interface WebhookContext<Principal> {
  event: string;
  payload: unknown;
  /**
   * The verified tenant.
   *
   * Non-null means the request verified — but NOT necessarily against this
   * company's own secret. On an event listed in `bootstrapEvents` the shared
   * bootstrap secret is also a candidate, and a reinstall verifies against it
   * while `resolve` still finds the existing company, so the handler sees that
   * company with a bootstrap-verified request.
   *
   * Null means the bootstrap secret verified and no company was found — a first
   * install, which the handler is expected to create. It is never null for an
   * unverified request: those are refused before the handler runs.
   */
  principal: Principal | null;
  headers: Headers;
  signal: AbortSignal;
  rawBody: string;
}

export interface WithFluidWebhookConfig<Principal> {
  /**
   * Locates the per-company secret and tenant from unverified routing hints.
   *
   * Unlike callbacks, webhook secrets are per-company, so the tenant must be
   * guessed from untrusted input *before* verification. That is inherent to the
   * scheme: resolve a candidate, verify against it, and only then trust it.
   * Returning null means no candidate — treated as an auth failure.
   */
  resolve: (
    hints: WebhookRoutingHints,
  ) => Promise<ResolvedWebhookPrincipal<Principal> | null>;

  /**
   * Shared token accepted only for the events in `bootstrapEvents`, which
   * defaults to `droplet.installed` alone.
   *
   * A first install has no per-company secret yet, so something has to
   * authenticate it. Every other event requires a signature: a shared value
   * accepted generally is a bypass, because one leaked copy authenticates
   * anything.
   */
  bootstrapSecret?: string;
  /**
   * The complete set of events permitted to use the bootstrap secret.
   *
   * REPLACES the default rather than adding to it, so a list that omits
   * `droplet.installed` stops installs verifying. Include it explicitly unless
   * that is what you intend. Defaults to `["droplet.installed"]`.
   *
   * Replacement rather than addition is deliberate for a security control: the
   * list is exactly what the caller sees when reading their own code, with no
   * inherited entry to overlook.
   */
  bootstrapEvents?: string[];
  logger?: Logger;
  name?: string;

  onAuthFailure?: (reason: string) => Response;
  onInvalidBody?: (reason: string) => Response;
  onHandlerError?: (error: unknown) => Response;
}

export type WebhookHandler<Principal> = (
  context: WebhookContext<Principal>,
) => Promise<Response | unknown>;

/**
 * Derives a canonical `resource.event` identifier from a Fluid webhook body.
 *
 * Fluid sends this two ways, and both are in production:
 *   { name: "droplet_installed", payload: {...} }
 *   { resource: "droplet", event: "installed", ... }
 *
 * The underscore form is normalised to dotted so callers compare against a
 * single spelling. Nested `payload.resource` / `payload.event` are also
 * checked, matching what the hand-written routes already do.
 */
export const eventOf = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") return "unknown";
  const record = payload as Record<string, unknown>;

  const name = record["name"];
  if (typeof name === "string" && name.length > 0) {
    // "droplet_installed" -> "droplet.installed"; leave already-dotted alone.
    return name.includes(".") ? name : name.replace("_", ".");
  }

  const nested = (record["payload"] ?? {}) as Record<string, unknown>;
  const resource = record["resource"] ?? nested["resource"];
  const event = record["event"] ?? nested["event"];

  if (typeof resource === "string" && typeof event === "string") {
    return `${resource}.${event}`;
  }
  if (typeof event === "string") return event;

  return "unknown";
};

/**
 * The object the event was actually derived FROM.
 *
 * `eventOf` accepts several shapes; everything downstream — tenant hints,
 * handler payload — has to look at the same object it chose, or the three
 * disagree. They did: the route kept its own unwrap rule, and every shape where
 * the two rules differed produced either a 500 from the handler or a 401 from
 * the resolver, because hints were read from the outer envelope where no
 * `company` exists.
 *
 * Precedence mirrors `eventOf` exactly, in the same order.
 */
export const effectivePayload = (body: unknown): unknown => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;

  const nested = record["payload"];
  const nestedIsObject =
    typeof nested === "object" && nested !== null && !Array.isArray(nested);

  // `name` wins in eventOf, so it wins here — even when root resource/event are
  // also present.
  const name = record["name"];
  if (typeof name === "string" && name.length > 0) {
    return nestedIsObject ? nested : record;
  }

  // Root pair next.
  if (
    typeof record["resource"] === "string" &&
    typeof record["event"] === "string"
  ) {
    return record;
  }

  // Then anything eventOf would have taken from the nested object, including
  // its `event`-only fallback.
  if (nestedIsObject) {
    const inner = nested as Record<string, unknown>;
    if (typeof inner["resource"] === "string" || typeof inner["event"] === "string") {
      return nested;
    }
  }

  return record;
};

const readHints = (
  body: unknown,
): Omit<WebhookRoutingHints, "payload" | "headers"> => {
  // Hints come from the effective payload, not the outer envelope. An
  // enveloped per-company webhook carries `company` inside `payload`, so
  // reading the outer object found no tenant, offered no candidate secret, and
  // failed closed with 401 for every such delivery.
  const payload = effectivePayload(body);
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const company = (record["company"] ?? {}) as Record<string, unknown>;
  const context = (record["context"] ?? {}) as Record<string, unknown>;

  const dri = company["droplet_installation_uuid"];
  const shop = company["fluid_shop"];
  const companyId =
    company["id"] ?? company["fluid_company_id"] ?? context["company_id"];

  return {
    dri: typeof dri === "string" ? dri : undefined,
    fluidShop: typeof shop === "string" ? shop : undefined,
    companyId:
      typeof companyId === "string" || typeof companyId === "number"
        ? companyId
        : undefined,
  };
};

/** Wraps a Fluid webhook route with HMAC verification. */
export function withFluidWebhook<Principal>(
  config: WithFluidWebhookConfig<Principal>,
  handler: WebhookHandler<Principal>,
) {
  const {
    resolve,
    bootstrapSecret,
    bootstrapEvents = [INSTALL_EVENT],
    logger = consoleLogger,
    name = "webhook",
    onAuthFailure = () =>
      Response.json({ error: "unauthorized" }, { status: 401 }),
    onInvalidBody = () =>
      Response.json({ error: "invalid request" }, { status: 400 }),
    onHandlerError = () =>
      Response.json({ error: "internal error" }, { status: 500 }),
  } = config;

  return async function POST(request: Request): Promise<Response> {
    const log = (
      level: "warn" | "error",
      message: string,
      context: Record<string, unknown> = {},
    ) => logger[level](`[fluid-webhook:${name}] ${message}`, context);

    let rawBody: string;
    try {
      rawBody = await request.text();
    } catch (error) {
      log("error", "could not read request body", describeError(error));
      return onInvalidBody("unreadable");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      log("warn", "body was not valid JSON");
      return onInvalidBody("malformed_json");
    }

    const event = eventOf(payload);
    const signature = request.headers.get(HEADER_SIGNATURE);
    const timestamp = request.headers.get(HEADER_TIMESTAMP);

    let principal: Principal | null = null;
    let authFailure: string | null = null;

    const resolved = await resolve({
      payload,
      headers: request.headers,
      ...readHints(payload),
      fluidShop:
        request.headers.get(HEADER_SHOP) ?? readHints(payload).fluidShop,
    }).catch((error) => {
      log("error", "resolve threw", describeError(error));
      return null;
    });

    // A bootstrap-eligible event accepts the SHARED secret and nothing else.
    //
    // Fluid signs lifecycle events with `fluid_webhook.auth_token`, never with
    // a company's token, so a per-company secret is not a legitimate signer
    // here — and accepting one was a cross-tenant takeover. The install handler
    // selects the company from `fluid_shop` in the payload, so anyone holding
    // ANY company's webhook_verification_token could sign a `droplet.installed`
    // naming ANOTHER company's shop and overwrite that company's
    // authentication_token, webhook_verification_token, DRI and active flag.
    // The signature verified — against the attacker's own company — and the
    // handler then wrote to the victim's row.
    //
    // Offering only the bootstrap secret for these events closes that: a
    // company token cannot sign a lifecycle event at all.
    const candidates: Array<{ label: string; secret: string }> = [];
    const isBootstrapEvent = bootstrapEvents.includes(event);

    if (isBootstrapEvent) {
      if (bootstrapSecret) {
        candidates.push({ label: "bootstrap", secret: bootstrapSecret });
      }
    } else if (resolved?.secret) {
      candidates.push({ label: "company", secret: resolved.secret });
    }

    if (candidates.length === 0) {
      // Covers both "no company found" and "resolver returned a blank secret",
      // which must never be used as an HMAC key.
      authFailure = resolved ? "blank_secret" : "unresolved_company";
    } else {
      let matched: string | null = null;
      let lastReason = "mismatch";

      for (const candidate of candidates) {
        const result = verifySignature({
          rawBody,
          signature,
          timestamp,
          secret: candidate.secret,
        });
        if (result.valid) {
          matched = candidate.label;
          break;
        }
        lastReason = result.reason;
      }

      if (matched === "company" && resolved) {
        principal = resolved.principal;
      } else if (matched === "bootstrap") {
        // Install events legitimately have no company yet; the handler creates it.
        principal = resolved?.principal ?? null;
      } else {
        authFailure = lastReason;
      }
    }

    // Every unverified webhook is refused. There is deliberately no mode that
    // runs the handler anyway — see the note in ./callbacks.ts for why the
    // callback wrapper's equivalent was removed.
    if (authFailure) {
      log("warn", "rejected", { reason: authFailure, event });
      return onAuthFailure(authFailure);
    }

    try {
      const result = await handler({
        event,
        payload,
        principal,
        headers: request.headers,
        signal: request.signal,
        rawBody,
      });
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      log("error", "handler threw", { event, ...describeError(error) });
      return onHandlerError(error);
    }
  };
}
