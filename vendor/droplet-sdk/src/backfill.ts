import { tokenDigest } from "./signatures";
import { consoleLogger, describeError, type Logger } from "./redact";
import type { CallbackTokenStore } from "./store/types";

/**
 * The subset of a Fluid client this backfill needs.
 *
 * Structural, so any client exposing this method satisfies it and the package
 * does not depend on a particular client implementation.
 */
export interface CallbackListingClient {
  /**
   * `GET /api/callback/registrations`.
   *
   * The params are optional so a zero-argument `listCallbacks()` still
   * satisfies this type — but a client that ignores them caps the backfill at
   * Fluid's default page size, so prefer one that forwards them.
   */
  listCallbacks(params?: { page?: number; per_page?: number }): Promise<{
    callback_registrations: Array<{
      uuid: string;
      definition_name: string;
      url: string;
      verification_token?: string;
    }>;
  }>;
}

/**
 * Fluid's index action defaults to `per_page: 10`. Ask for more per request,
 * but still page — asking is not the same as receiving, and a droplet with more
 * registrations than one page would otherwise be backfilled only in part and
 * then reject the remainder once enforcing.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface BackfillResult {
  stored: number;
  skipped: number;
  /** definition_name values whose registration carried no token. */
  missingToken: string[];
  /** Registrations belonging to a different droplet, skipped. */
  foreign: number;
  /**
   * What was actually adopted, in the order it was stored.
   *
   * `stored` alone cannot establish coverage: two token-bearing registrations
   * for one definition and none for another give `stored: 2` with an empty
   * `missingToken`, which looks complete and is not. Callers that need to know
   * every expected definition is covered — which is every caller about to
   * enable verification — have to compare the definitions adopted against the
   * definitions they expect.
   */
  adopted: Array<{ uuid: string; definitionName: string; url: string }>;
}

/**
 * One spelling per address, for the urls WE build.
 *
 * `ownUrls` are assembled by concatenation — `${FLUID_DROPLET_URL}${callback.url}`
 * — so a base url carrying a trailing slash yields `//api/callbacks/x`, and a
 * live registration at the ordinary path would be called foreign over a
 * difference that is ours.
 *
 * Deliberately applied to the owned set ONLY, never to a registration url. A
 * repeated slash is a genuinely distinct path, so normalising the other side
 * would let a co-installed droplet register `/api//callbacks/x` — or
 * `/foreign/../api/callbacks/x`, which URL also resolves — and have its token
 * adopted as ours. That trades a fail-closed miss for a fail-open admission,
 * which is the worse direction on the boundary this function guards.
 */
function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The second address this droplet is served on, if it has one.
 *
 * Cloud Run answers one service on two equivalent hostnames — the
 * `<service>-<suffix>.a.run.app` form and the
 * `<service>-<projectNumber>.<region>.run.app` form — and which one a callback
 * registration holds depends on how the droplet was configured when it was
 * registered. That has varied across this fleet.
 *
 * It matters because ownership here is an EXACT url match, deliberately: the
 * listing endpoint is company-scoped, so a co-installed droplet could otherwise
 * register one of our definitions on our host at a path we do not serve and
 * have its token adopted. Exact matching is what stops that — but it also
 * strands a registration that IS ours on the sibling hostname: its token is
 * never adopted, and once verification is enforced its callbacks are refused.
 * This is not hypothetical: it has been observed on a live installation.
 *
 * ## Why this is supplied, not derived
 *
 * Earlier revisions computed the sibling host from the deployment's project
 * number, region and url suffix. Every version of that was unsound: those
 * values can each be present and still not describe one deployment, and a
 * correct suffix beside a wrong project number yields a same-named service in
 * somebody else's project — reachable on a service-name match alone. Nothing
 * the droplet knows offline can rule that out, so no amount of validation made
 * it fail closed.
 *
 * So it is not derived. The caller supplies the exact address, resolved from an
 * authoritative source — the deployment workflow asks gcloud — and an absent or
 * unparseable value yields no sibling at all. Ownership is only ever widened to
 * an address someone with access to the deployment stated is ours.
 */
function siblingOriginFromEnv(): string | null {
  const alt = process.env.FLUID_DROPLET_ALT_URL?.trim();
  if (!alt) return null;
  try {
    const parsed = new URL(alt);
    // ORIGIN, not host. Carrying only the host across would keep the SOURCE
    // url's scheme, so an `http://` entry would manufacture `http://sibling/…`
    // — an address nobody authorised. Anything but https is refused outright: a
    // callback carrying a verification token has no business on plaintext.
    if (parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/*
 * IMPLEMENTATION NOTES — not JSDoc, deliberately.
 *
 * A doc comment above an exported symbol is emitted into the `.d.ts` and
 * published.
 * The reasoning below is about how ownership is decided and what goes wrong
 * when it is decided wrongly, which is for maintainers, not for a public
 * registry. Keep the exported doc comment to what a consumer needs.
 *
 * Why `dropletUrl` matters: `GET /api/callback/registrations` is scoped to the
 * COMPANY, not the installation — it lists every registration the company has,
 * including those owned by other droplets, and exposes no owner filter.
 * Adopting all of them would stamp another droplet's registrations with this
 * droplet's `dri`, so `deleteForInstallation` would later delete rows that were
 * never ours; and where two droplets serve the same definition name, the other
 * droplet's token would then verify at our route.
 *
 * `owner_id` cannot tell them apart — the blueprint renders it as a numeric id
 * for a DropletInstallation, not the `dri_` slug. The registration `url` is the
 * discriminator a droplet can actually check, since it knows its own.
 *
 * Why origin alone is not enough: comparing parsed origins rejects the
 * `https://ours.example.com.attacker.tld` prefix trap but accepts ANY path on
 * our host, so a second droplet installed for the same company could register
 * one of our definitions at a path we do not serve, keep the token, and we
 * would adopt it — the wrapper matches on definitionName, not on url. So
 * `ownUrls` is matched exactly, the same way `cleanupCallbacks` decides what it
 * may delete.
 */

/**
 * Populates the callback token store for an installation that predates the SDK.
 *
 * Fluid returns `verification_token` on its registration listing as well as on
 * create, so existing registrations are adopted without re-registering and
 * without a reinstall.
 *
 * Until this has run an installation has no stored tokens, every lookup misses,
 * and enforcing verification would reject its callbacks. Run it, for every
 * installation, before deploying wrapped routes.
 *
 * `ownUrls` must list the exact callback urls this droplet registers. The
 * listing is company-scoped and includes other droplets' registrations, so this
 * is what decides which tokens may be adopted; anything else is counted in
 * `foreign` and skipped. Set `FLUID_DROPLET_ALT_URL` if the same service is
 * also served on a second address.
 *
 * @returns counts of what was `stored`, `skipped` and `foreign`, plus
 * `missingToken` — definitions whose registration carried no token and which
 * therefore cannot be adopted at all.
 */
export async function backfillCallbackTokens({
  client,
  store,
  dri,
  dropletUrl,
  ownUrls,
  logger = consoleLogger,
}: {
  client: CallbackListingClient;
  store: CallbackTokenStore;
  dri: string;
  /**
   * This droplet's public base URL (`FLUID_DROPLET_URL`).
   *
   * Required, and validated: without it there is no way to tell our
   * registrations from another droplet's, and defaulting to "adopt everything"
   * would hand us their tokens. An absent value is a misconfiguration, so it
   * throws rather than quietly adopting the lot.
   */
  dropletUrl: string;
  /**
   * The exact callback URLs this droplet registers. Only registrations whose
   * url is in this set are adopted.
   *
   * Required, and must not be empty. Matching on origin alone is not
   * sufficient: it accepts ANY path on this host, so a co-installed droplet
   * could register one of our definitions at a path we do not serve and have
   * its token adopted as ours.
   */
  ownUrls: string[];
  logger?: Logger;
}): Promise<BackfillResult> {
  const ownOrigin = originOf(dropletUrl);
  if (!ownOrigin) {
    throw new Error(
      "backfillCallbackTokens requires dropletUrl (FLUID_DROPLET_URL) to be a valid absolute URL; " +
        "without it, another droplet's registrations cannot be told apart from ours",
    );
  }

  // Each configured url, plus that same path on the sibling origin this droplet
  // is also served on. See siblingOriginFromEnv.
  const siblingOrigin = siblingOriginFromEnv();
  const withSibling = (url: string): string[] => {
    if (!siblingOrigin) return [url];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [url];
    }
    // Compared by ORIGIN, so an entry merely sharing the host on another scheme
    // or port does not qualify. An ownUrls entry elsewhere is a url the caller
    // claims for its own reasons; giving it a sibling would claim an address
    // nobody declared.
    if (parsed.origin !== ownOrigin) return [url];
    // Built FROM the sibling origin, so scheme and port come from the
    // authorised address rather than from the entry being rewritten.
    return [
      url,
      canonicalUrl(
        `${siblingOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`,
      ),
    ];
  };
  if (!ownUrls || ownUrls.length === 0) {
    throw new Error(
      "backfillCallbackTokens requires ownUrls: the exact callback urls this " +
        "droplet registers. Without them there is no safe way to tell our " +
        "registrations from a co-installed droplet's on the same host",
    );
  }
  const ownUrlSet = new Set(ownUrls.map(canonicalUrl).flatMap(withSibling));

  const result: BackfillResult = {
    stored: 0,
    skipped: 0,
    adopted: [],
    missingToken: [],
    foreign: 0,
  };

  type Registration = Awaited<
    ReturnType<CallbackListingClient["listCallbacks"]>
  >["callback_registrations"][number];

  const registrations: Registration[] = [];
  const seen = new Set<string>();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch =
        (await client.listCallbacks({ page, per_page: PAGE_SIZE }))
          .callback_registrations ?? [];

      // A client that drops the params returns page 1 forever. Detecting the
      // repeat is what stops that becoming an infinite loop.
      const fresh = batch.filter((r) => !seen.has(r.uuid));
      fresh.forEach((r) => seen.add(r.uuid));
      registrations.push(...fresh);

      // Deliberately not `batch.length < PAGE_SIZE`: Fluid caps per_page at
      // 100 today, but a lower cap — or a client that drops the params — would
      // make every page look like the last one and silently truncate. Stop only
      // on a genuinely empty page, or when a page adds nothing new (which is
      // what a params-ignoring client produces on its second call).
      if (batch.length === 0 || fresh.length === 0) break;

      if (page === MAX_PAGES) {
        logger.warn(
          "[backfill] stopped at the page limit; some registrations may not be stored",
          { pages: MAX_PAGES, collected: registrations.length },
        );
      }
    }
  } catch (error) {
    logger.error(
      "[backfill] could not list callback registrations",
      describeError(error),
    );
    throw error;
  }

  for (const registration of registrations) {
    // Another droplet's registration, listed only because the endpoint is
    // company-scoped. Adopting it would give us its token and put our dri on
    // its row.
    //
    // Compared EXACTLY, never as a prefix: `startsWith` on
    // "https://rewards.example.com" also matches
    // "https://rewards.example.com.attacker.tld". The owned set is
    // canonicalised because we build it and know where a doubled slash comes
    // from; a registration url is somebody else's assertion, and normalising it
    // would let a co-installed droplet register `/api//callbacks/x` and have
    // its token adopted as ours.
    const ours = ownUrlSet.has(registration.url);
    if (!ours) {
      result.foreign++;
      continue;
    }

    if (!registration.verification_token || !registration.uuid) {
      result.skipped++;
      result.missingToken.push(registration.definition_name);
      continue;
    }

    await store.upsert({
      uuid: registration.uuid,
      dri,
      definitionName: registration.definition_name,
      tokenDigest: tokenDigest(registration.verification_token),
      url: registration.url,
    });
    result.adopted.push({
      uuid: registration.uuid,
      definitionName: registration.definition_name,
      url: registration.url,
    });
    result.stored++;
  }

  if (result.missingToken.length > 0) {
    // The one case that forces re-registration rather than adoption.
    logger.warn(
      "[backfill] registrations returned without a verification_token; these cannot be verified until re-registered",
      { definitions: result.missingToken },
    );
  }

  logger.info("[backfill] complete", {
    stored: result.stored,
    skipped: result.skipped,
    foreign: result.foreign,
  });

  return result;
}

/**
 * The origin of a URL, or null if it is not a parseable absolute URL.
 *
 * Ownership is an origin comparison, not a string comparison — see the call
 * site for why prefix matching is unsafe here.
 */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
