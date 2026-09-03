/**
 * Moves ONE company's callback registrations between the Rails app and the
 * Next app, and repairs the state left behind when that goes wrong halfway.
 *
 *   pnpm cutover status    <fluid_shop>
 *   APPLY=1 pnpm cutover repoint   <fluid_shop> --url https://droplet-newulife-payment-next-...run.app
 *   APPLY=1 pnpm cutover reconcile <fluid_shop> --url https://droplet-newulife-payment-next-...run.app
 *
 * This droplet has exactly ONE callback: the Fluid definition
 * `redirect_cart_payment`. Rails served it at `POST /get_redirect_url` and this
 * app serves it at `POST /api/callbacks/redirect-cart-payment`, so a repoint
 * changes the PATH as well as the host — see CALLBACK_PATHS below.
 *
 * IT DOES NOT MOVE THE MONEY PATH. `redirect_cart_payment` is leg ① of five.
 * The uPayments browser return, the Moola webhook, `order.external_id_synced`
 * and the ByDesign recording are NOT registrations Fluid holds, and this tool
 * cannot move them. Read CUTOVER.md before running it: legs ②③④⑤ move together,
 * in a maintenance window, or not at all.
 *
 * The important thing about this operation, established from Fluid's own
 * source rather than assumed:
 *
 *   - `Callback::Registration` sets `verification_token` in `before_create`
 *     ONLY. An update never rotates it.
 *   - `RegistrationBlueprint`'s `:shared` view exposes `verification_token`,
 *     and both `api_index` and `api_show` include that view. `api_update` does
 *     NOT.
 *   - `UpdateAction` accepts `url`.
 *
 * Together those mean a repoint is an UPDATE, not a delete-then-create. The
 * registration keeps its uuid and its token; only the url moves. That removes
 * both failure modes the delete-create shape has: there is never a moment when
 * the definition has no registration and Fluid silently stops calling, and
 * there is no create response whose loss strands a live registration whose
 * token was issued exactly once and received by nobody.
 *
 * The token is then read back from the listing and its digest stored. Fluid
 * enforces one registration per definition_name per owner, so this is still a
 * genuine switch rather than a fan-out — but it is a switch with no gap.
 *
 * Delete-then-create remains only for the case where no registration exists to
 * update.
 *
 * Writes require APPLY=1. `status` never writes.
 */

import { prisma } from "@/lib/db";
import { createFluidClient, type FluidClient } from "@/lib/fluid";
import { callbackStore } from "@/lib/callbacks";
import { activeCallbacks } from "@/lib/callbacks/registration";
import { dropletConfig } from "@/lib/config";
import { tokenDigest } from "@fluid-app/droplet-sdk";

const APPLY = process.env.APPLY === "1";

type Registration = {
  uuid: string;
  definition_name: string;
  url: string;
  verification_token?: string;
};

/**
 * The two paths a callback registration of ours can sit at.
 *
 * The template derived the destination path from the `callbacks.url` row and
 * only swapped the origin. That is wrong HERE, and silently so: this repo's two
 * apps do not agree on the path. Rails routes `post "get_redirect_url"`
 * (config/routes.rb) and this app routes
 * `src/app/api/callbacks/redirect-cart-payment/route.ts`. Keeping a path from
 * the other app would repoint production at a route the target does not have,
 * and the symptom is not a 404 anyone sees: `redirect_cart_payment` is
 * checkout-blocking, so the shopper is simply told the payment could not be
 * started, with no error rate moving anywhere.
 *
 * So the path is stated, not inherited, in the same way `--webhook-path` is.
 * Both paths are also the recognition set: a registration of ours can currently
 * be at either one, and that is how a first cutover finds the Rails
 * registration it has no digest for.
 */
const NEXT_CALLBACK_PATH = "/api/callbacks/redirect-cart-payment";
const RAILS_CALLBACK_PATH = "/get_redirect_url";
const CALLBACK_PATHS = [NEXT_CALLBACK_PATH, RAILS_CALLBACK_PATH];

/**
 * The two paths a webhook of ours can be registered at.
 *
 * Rails serves `POST /webhook` (config/routes.rb) and the Next app serves
 * `POST /api/webhooks`. Looking for only the Next path meant a first cutover —
 * where every webhook is still on the Rails path — matched NOTHING, printed a
 * single ATTN line, and exited zero with the callbacks moved and the webhooks
 * left behind on Rails.
 */
const NEXT_WEBHOOK_PATH = "/api/webhooks";
const RAILS_WEBHOOK_PATH = "/webhook";
const WEBHOOK_PATHS = [NEXT_WEBHOOK_PATH, RAILS_WEBHOOK_PATH];

type FluidWebhook = {
  id: number | string;
  resource: string;
  event: string;
  url: string;
};

/**
 * The webhooks THIS droplet registered, as Fluid currently holds them.
 *
 * Matched on an exact expected url, for the same reason callbacks are: the
 * listing is company-scoped, and another droplet subscribed to the same
 * resource+event appears in it.
 */
function ourWebhooks(
  webhooks: FluidWebhook[],
  origins: string[],
): FluidWebhook[] {
  const enabled = dropletConfig.webhooks.filter((w) => w.enabled !== false);
  const expected = origins.flatMap((origin) =>
    WEBHOOK_PATHS.map((path) => `${origin}${path}`),
  );
  return webhooks.filter(
    (w) =>
      expected.includes(w.url) &&
      enabled.some((e) => e.resource === w.resource && e.event === w.event),
  );
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/**
 * An operator-supplied `--url` / `--from`, reduced to something safe to
 * concatenate a path onto.
 *
 * Only http(s) is accepted, and a query or fragment is refused: `${base}${path}`
 * on `https://host/?x` produces `https://host/?x/api/...`, which registers a
 * url nothing serves.
 */
function normaliseOrigin(value: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${flag} must be an absolute https url; got "${value}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(`${flag} must be http(s); got "${value}".`);
  }
  if (parsed.search || parsed.hash) {
    fail(`${flag} must not carry a query or fragment; got "${value}".`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
}

/**
 * A `--callback-path` / `--webhook-path`, checked before it is concatenated.
 *
 * A value that does not begin with "/" is not a path. `${origin}${value}` on
 * "@evil.example/x" yields `https://host@evil.example/x`, whose host is
 * evil.example — the flag would be choosing the destination host.
 */
function normalisePath(value: string, flag: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    fail(
      `${flag} must be an absolute path beginning with a single "/"; got "${value}".`,
    );
  }
  return value;
}

async function loadCompany(handle: string) {
  const company = await prisma.company.findFirst({
    where: { OR: [{ fluidShop: handle }, { id: Number(handle) || -1 }] },
  });
  if (!company) fail(`No company matches "${handle}".`);
  if (!company.dropletInstallationUuid) {
    fail(
      `Company ${company.fluidShop} has no droplet_installation_uuid. Every ` +
        `stored token is bound to that value, so a registration made now could ` +
        `not be resolved to a tenant when its callback arrives.`,
    );
  }
  return company;
}

/**
 * Fluid's registrations for this installation, paged to the end.
 *
 * The listing is COMPANY-scoped, not droplet-scoped: it also returns
 * registrations belonging to other droplets installed for the same company. So
 * everything below matches on definition name plus url, never on definition
 * name alone.
 */
async function fluidRegistrations(client: FluidClient): Promise<Registration[]> {
  const all: Registration[] = [];
  for (let page = 1; page <= 50; page++) {
    const response = await client.listCallbacks({ page, per_page: 100 });
    const batch = (response?.callback_registrations ?? []) as Registration[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  fail("Fluid returned more than 50 pages of registrations; refusing to guess.");
}

async function storedFor(dri: string) {
  return prisma.fluidCallbackRegistration.findMany({ where: { dri } });
}

/** Creates one registration and persists its token, or leaves nothing behind. */
async function createAndPersist(
  client: FluidClient,
  dri: string,
  definitionName: string,
  url: string,
  timeoutInSeconds: number,
): Promise<string> {
  const response = await client.createCallback({
    definition_name: definitionName,
    url,
    timeout_in_seconds: timeoutInSeconds,
    active: true,
  });
  const registration = response?.callback_registration as
    | Registration
    | undefined;

  if (!registration?.uuid) {
    throw new Error(
      `Fluid returned no uuid for ${definitionName}. A registration may or may ` +
        `not exist — run 'reconcile' before retrying.`,
    );
  }

  // A live registration exists from here. Anything that fails below has to
  // remove it, because we would be unable to verify its callbacks.
  if (!registration.verification_token) {
    await client.deleteCallback(registration.uuid).catch(() => {});
    throw new Error(
      `Fluid returned no verification_token for ${definitionName}; deleted the ` +
        `registration rather than leave one we cannot verify.`,
    );
  }

  try {
    await callbackStore.upsert({
      uuid: registration.uuid,
      dri,
      definitionName: registration.definition_name,
      tokenDigest: tokenDigest(registration.verification_token),
      url: registration.url,
    });
  } catch (error) {
    await client.deleteCallback(registration.uuid).catch(() => {});
    throw new Error(
      `Stored no digest for ${definitionName} (${
        error instanceof Error ? error.message : error
      }); deleted the registration so it cannot sit live and unverifiable.`,
    );
  }

  return registration.uuid;
}

async function status(handle: string) {
  const company = await loadCompany(handle);
  const dri = company.dropletInstallationUuid!;
  const client = createFluidClient(company.authenticationToken);

  const [live, stored, active] = await Promise.all([
    fluidRegistrations(client),
    storedFor(dri),
    activeCallbacks(),
  ]);
  const storedByUuid = new Map(stored.map((row) => [row.uuid, row]));

  console.log(`Company ${company.fluidShop} (id ${company.id}, dri ${dri})`);
  console.log(`Fluid holds ${live.length} registration(s) for this company:\n`);

  for (const registration of live) {
    // THREE states, not two. "we hold a row" and "we hold this registration's
    // current token" are different questions, and only the second predicts
    // whether a callback will verify.
    const label = !storedByUuid.has(registration.uuid)
      ? "NO TOKEN"
      : verifiablyHeld(registration, stored)
        ? "ok      "
        : "STALE   ";
    console.log(
      `  ${label} ${registration.definition_name.padEnd(24)} ${registration.url}`,
    );
  }

  const stale = live.filter(
    (r) => storedByUuid.has(r.uuid) && !verifiablyHeld(r, stored),
  );
  if (stale.length > 0) {
    console.log(
      `\n${stale.length} registration(s) are STALE: we hold a row, but its digest ` +
        `is not this registration's current token. Those callbacks are being ` +
        `refused behind a 200 right now. 'reconcile' re-reads them.`,
    );
  }

  const orphanRows = stored.filter(
    (row) => !live.some((registration) => registration.uuid === row.uuid),
  );
  if (orphanRows.length > 0) {
    console.log(
      `\n${orphanRows.length} stored digest(s) reference a registration Fluid no ` +
        `longer has. Harmless — nothing routes to them — but 'repoint' will ` +
        `clear them.`,
    );
  }

  const unverifiable = live.filter((r) => !storedByUuid.has(r.uuid));
  if (unverifiable.length > 0) {
    console.log(
      `\n${unverifiable.length} live registration(s) have no stored token. If any ` +
        `is at THIS app's url, its callbacks are being refused right now behind ` +
        `a 200. 'reconcile' fixes those by re-creating them.`,
    );
  }

  // The `callbacks` table's own url, printed because repoint does NOT touch it
  // and a NEW installation registers from it. A company can be fully cut over
  // while the next install registers straight back onto Rails — see step 4 of
  // CUTOVER.md.
  console.log(`\nThis droplet defines ${active.length} active callback(s):`);
  for (const callback of active) {
    let path = "";
    try {
      path = new URL(callback.url).pathname;
    } catch {
      path = callback.url;
    }
    const note =
      path === NEXT_CALLBACK_PATH
        ? ""
        : path === RAILS_CALLBACK_PATH
          ? "   <- still the RAILS path; new installs would register onto Rails"
          : "   <- neither app serves this path";
    console.log(`  ${callback.name.padEnd(24)} ${callback.url}${note}`);
  }
}

/**
 * Reads a registration's token back from Fluid and stores its digest.
 *
 * `api_show` renders the `:shared` view, which carries `verification_token`.
 * That is what makes an in-place repoint possible at all: the token is not
 * returned by update, but it has not changed, and it can simply be read again.
 */
async function adoptToken(
  client: FluidClient,
  dri: string,
  uuid: string,
): Promise<string> {
  const response = await client.getCallback(uuid);
  const registration = response?.callback_registration as
    | Registration
    | undefined;

  if (!registration?.verification_token) {
    throw new Error(
      `Fluid returned no verification_token for ${uuid}. Without it this ` +
        `registration cannot be verified, and its callbacks would be refused ` +
        `behind a 200.`,
    );
  }

  await callbackStore.upsert({
    uuid: registration.uuid,
    dri,
    definitionName: registration.definition_name,
    tokenDigest: tokenDigest(registration.verification_token),
    url: registration.url,
  });
  return registration.url;
}

/**
 * Whether we hold the CURRENT token for this registration.
 *
 * NOT "is there a row with this uuid". A row holding the digest of a token that
 * has since been replaced is indistinguishable by uuid from a correct one, and
 * every callback against it is refused behind a 200 — the exact silent failure
 * this tooling exists to surface. `api_index` and `api_show` return the live
 * token, so the comparison costs nothing.
 */
function verifiablyHeld(
  registration: Registration,
  stored: { uuid: string; tokenDigest: string }[],
): boolean {
  const row = stored.find((r) => r.uuid === registration.uuid);
  if (!row) return false;
  // No token in the response means we cannot prove it either way. Treated as
  // NOT held: assuming otherwise fails silently, re-adopting merely costs a
  // call.
  if (!registration.verification_token) return false;
  return row.tokenDigest === tokenDigest(registration.verification_token);
}

/**
 * Picks the registration that is OURS for a definition.
 *
 * The listing is company-scoped, so another droplet installed for the same
 * company can hold a registration with the same definition_name — Fluid's
 * uniqueness is per definition per OWNER. Matching on definition_name alone
 * would repoint someone else's callback at our app, which is both an outage
 * for them and traffic we cannot verify.
 *
 * So: a registration we already hold a digest for is unambiguously ours;
 * failing that, one whose url is on a host we are moving between. Anything
 * still ambiguous is reported, never guessed.
 */
function ourRegistration(
  candidates: Registration[],
  heldUuids: Set<string>,
  expectedUrls: string[],
): Registration | "ambiguous" | undefined {
  const held = candidates.filter((r) => heldUuids.has(r.uuid));
  if (held.length === 1) return held[0];
  if (held.length > 1) return "ambiguous";

  // EXACT match, never a prefix. `startsWith(origin)` accepts
  // `https://our-app.run.app.attacker.example/...`, and on a shared host it
  // accepts a sibling droplet's path under the same origin.
  const recognised = candidates.filter((r) => expectedUrls.includes(r.url));
  if (recognised.length === 1) return recognised[0];
  if (recognised.length > 1) return "ambiguous";

  return undefined;
}

/** Every url a registration of ours could currently sit at, on either host. */
function recognisedUrls(origins: string[]): string[] {
  return origins.flatMap((origin) =>
    CALLBACK_PATHS.map((path) => `${origin}${path}`),
  );
}

async function repoint(
  handle: string,
  targetUrl: string,
  fromUrl: string | undefined,
  callbackPath: string,
  webhookPath: string,
) {
  const company = await loadCompany(handle);
  const dri = company.dropletInstallationUuid!;
  const client = createFluidClient(company.authenticationToken);

  const live = await fluidRegistrations(client);
  const stored = await storedFor(dri);
  const heldUuids = new Set(stored.map((row) => row.uuid));
  const active = await activeCallbacks();

  // ---- PREFLIGHT ----------------------------------------------------------
  // Every definition is resolved before ANY of them is mutated. Resolving as we
  // went meant an ambiguity or an API error on the third definition was
  // discovered with the first two already moved — leaving one company answering
  // from two different apps inside a single checkout, which is a different
  // price or tax in one basket.
  //
  // This droplet has one definition today, so that ordering costs nothing here;
  // it is kept because the cost of getting it wrong later is a split company.
  type Plan = {
    name: string;
    timeoutInSeconds: number;
    destination: string;
    current?: Registration;
    action: "update" | "create" | "noop";
  };
  const plans: Plan[] = [];

  const expected = recognisedUrls([targetUrl, ...(fromUrl ? [fromUrl] : [])]);

  for (const callback of active) {
    const destination = `${targetUrl}${callbackPath}`;
    const candidates = live.filter((r) => r.definition_name === callback.name);
    const current = ourRegistration(candidates, heldUuids, expected);

    if (current === "ambiguous") {
      fail(
        `  FAIL  ${callback.name}: ${candidates.length} registrations match and ` +
          `none is unambiguously ours. NOTHING has been changed. Resolve by hand:\n` +
          candidates.map((r) => `    ${r.uuid}  ${r.url}`).join("\n"),
      );
    }

    const settled =
      current && current.url === destination && verifiablyHeld(current, stored);

    plans.push({
      name: callback.name,
      timeoutInSeconds: callback.timeoutInSeconds,
      destination,
      current,
      action: settled ? "noop" : current ? "update" : "create",
    });
  }

  // Webhooks are discovered HERE, with the callbacks, not after they have been
  // mutated. They are part of the same routing unit: a company whose callbacks
  // moved and whose webhooks did not is half cut over, and finding that out
  // afterwards means finding it out too late.
  // NOT hardcoded to the Next path. Rails serves `POST /webhook` and this app
  // serves `POST /api/webhooks`, so a ROLLBACK that always builds the Next path
  // would move every webhook to `https://rails/api/webhooks` — a route Rails
  // does not have, and every subsequent delivery 404s. The direction cannot be
  // inferred from the urls, so it is stated: CUTOVER.md's rollback passes
  // `--webhook-path /webhook`.
  const webhookDestination = `${targetUrl}${webhookPath}`;
  const enabledWebhooks = dropletConfig.webhooks.filter(
    (w) => w.enabled !== false,
  );
  let webhookPlans: FluidWebhook[] = [];

  // This droplet enables NO per-company webhooks — both entries in
  // droplet.config.ts are `enabled: false`, and its only Fluid traffic is the
  // callback plus the droplet-level lifecycle webhook, which is not
  // per-installation and is not moved here (CUTOVER.md step 4).
  //
  // Listing anyway would make a Fluid API blip fail a cutover that has no
  // webhooks to move, so it is skipped — loudly, so nobody reads the absence of
  // webhook lines as "the webhooks moved".
  if (enabledWebhooks.length === 0) {
    console.log(
      `NOTE  droplet.config.ts enables no per-company webhooks, so none are ` +
        `moved by this command. The droplet-level droplet.installed /\n` +
        `      droplet.uninstalled registration is global and is moved by hand ` +
        `— see step 4 of CUTOVER.md.\n`,
    );
  } else {
    try {
      const webhooks = ((await client.listWebhooks())?.webhooks ??
        []) as FluidWebhook[];
      const mine = ourWebhooks(webhooks, [
        targetUrl,
        ...(fromUrl ? [fromUrl] : []),
      ]);

      // COMPLETENESS, matching the callback preflight. Silently proceeding with
      // whatever subset happened to match is how a company ends up split: a
      // webhook whose url has drifted to something this tool does not recognise
      // is simply absent from `mine`, and the run would move everything else and
      // print Done.
      //
      // Exactly one registration per enabled definition, or stop.
      const problems: string[] = [];
      for (const definition of enabledWebhooks) {
        const matches = mine.filter(
          (w) =>
            w.resource === definition.resource && w.event === definition.event,
        );
        const label = `${definition.resource}.${definition.event}`;
        if (matches.length === 0) {
          const drifted = webhooks.filter(
            (w) =>
              w.resource === definition.resource && w.event === definition.event,
          );
          problems.push(
            drifted.length === 0
              ? `    ${label}: not registered with Fluid at all`
              : `    ${label}: registered at an unrecognised url — ` +
                drifted.map((w) => w.url).join(", "),
          );
        } else if (matches.length > 1) {
          // Two owners can subscribe to the same resource+event. Repointing the
          // wrong one is an outage for the other droplet.
          problems.push(
            `    ${label}: ${matches.length} registrations match — ` +
              matches.map((w) => `${w.id} ${w.url}`).join(", "),
          );
        }
      }
      if (problems.length > 0) {
        fail(
          `  FAIL  this company's webhooks cannot be resolved unambiguously. ` +
            `NOTHING has been changed:\n${problems.join("\n")}\n` +
            `\n  Moving the callbacks without them would split this company ` +
            `across both apps.`,
        );
      }

      webhookPlans = mine.filter((w) => w.url !== webhookDestination);
    } catch (error) {
      // `fail()` calls process.exit, so the completeness check above cannot land
      // here — this only catches a genuine listing failure.
      fail(
        `  FAIL  could not list webhooks (${error instanceof Error ? error.message : error}). ` +
          `NOTHING has been changed — refusing to move callbacks without knowing ` +
          `where this company's webhooks point.`,
      );
    }
  }

  console.log(
    `${APPLY ? "REPOINTING" : "DRY RUN for"} ${company.fluidShop} -> ${targetUrl}\n`,
  );

  if (!APPLY) {
    for (const plan of plans) {
      console.log(
        plan.action === "noop"
          ? `  ok    ${plan.name}: already at ${plan.destination}`
          : plan.action === "update"
            ? `  WOULD ${plan.name}: update ${plan.current!.uuid} ${plan.current!.url} -> ${plan.destination}`
            : `  WOULD ${plan.name}: create at ${plan.destination} (nothing registered)`,
      );
    }
    for (const webhook of webhookPlans) {
      console.log(
        `  WOULD webhook ${webhook.resource}.${webhook.event}: ${webhook.url} -> ${webhookDestination}`,
      );
    }
    console.log(`\nDry run only. Re-run with APPLY=1.`);
    return;
  }

  // ---- APPLY --------------------------------------------------------------
  // Original urls are captured as we go, so a partial failure can be described
  // exactly rather than reconstructed.
  const done: { name: string; from: string }[] = [];

  for (const plan of plans) {
    if (plan.action === "noop") {
      console.log(`  ok    ${plan.name}: already at ${plan.destination}`);
      continue;
    }
    try {
      if (plan.action === "update") {
        const previous = plan.current!.url;
        await client.updateCallback(plan.current!.uuid, {
          url: plan.destination,
        });
        // Recorded BEFORE adopting. The url has already moved at this point,
        // so a failure inside adoptToken must still report this definition as
        // moved — previously it did not, and the failure message said
        // "Already moved: (none)" about a company that had just been split.
        done.push({ name: plan.name, from: previous });
        const url = await adoptToken(client, dri, plan.current!.uuid);
        console.log(`  moved ${plan.name}: ${previous} -> ${url}`);
      } else {
        const uuid = await createAndPersist(
          client,
          dri,
          plan.name,
          plan.destination,
          plan.timeoutInSeconds,
        );
        console.log(`  created ${plan.name}: ${plan.destination} (${uuid})`);
      }
    } catch (error) {
      const moved = done.length
        ? done.map((d) => `      ${d.name}: at target, was ${d.from}`).join("\n")
        : "      (none)";
      fail(
        `  FAIL  ${plan.name}: ${error instanceof Error ? error.message : error}\n` +
          `\n  This company is now SPLIT across two apps. Already moved:\n${moved}\n` +
          `\n  Put them back with:\n` +
          `    ${rollbackCommand(handle, targetUrl, fromUrl, callbackPath, webhookPath)}\n` +
          `  then investigate before trying again.`,
      );
    }
  }

  // Webhooks, from the set discovered during preflight.
  const movedWebhooks: string[] = [];
  for (const webhook of webhookPlans) {
    const label = `${webhook.resource}.${webhook.event}`;
    try {
      // Fluid's update takes the whole registration rather than a patch, so
      // fields we are not changing are sent back unchanged; omitting them would
      // blank the subscription this webhook exists for.
      await client.updateWebhook(String(webhook.id), {
        resource: webhook.resource,
        event: webhook.event,
        url: webhookDestination,
        auth_token: process.env.FLUID_WEBHOOK_AUTH_TOKEN ?? "",
        active: true,
      });
      movedWebhooks.push(label);
      console.log(
        `  moved webhook ${label}: ${webhook.url} -> ${webhookDestination}`,
      );
    } catch (error) {
      // Exits NON-ZERO. This used to be caught, logged as ATTN, and followed by
      // "Done" and exit 0 — reporting success for a company left split across
      // two apps on its async path.
      const callbacks = done.length
        ? done
            .map((d) => `      callback ${d.name}: at target, was ${d.from}`)
            .join("\n")
        : "      (no callbacks moved)";
      const webhooksMoved = movedWebhooks.length
        ? movedWebhooks.map((w) => `      webhook ${w}: at target`).join("\n")
        : "      (no webhooks moved)";
      fail(
        `  FAIL  webhook ${label}: ${error instanceof Error ? error.message : error}\n` +
          `\n  This company is now SPLIT. Already moved:\n${callbacks}\n${webhooksMoved}\n` +
          `\n  Put them back with:\n` +
          `    ${rollbackCommand(handle, targetUrl, fromUrl, callbackPath, webhookPath)}`,
      );
    }
  }

  console.log(
    `\nDone. Verify with: pnpm cutover status ${handle}`,
  );
}

/**
 * The exact command that undoes the repoint currently in progress.
 *
 * Both paths are inverted, not just the webhook one: the two apps disagree on
 * the callback path as well, so a rollback that kept `--callback-path` pointing
 * at the Next route would send `redirect_cart_payment` to
 * `https://<rails>/api/callbacks/redirect-cart-payment`, which Rails does not
 * route.
 */
function rollbackCommand(
  handle: string,
  targetUrl: string,
  fromUrl: string | undefined,
  callbackPath: string,
  webhookPath: string,
): string {
  const backCallback =
    callbackPath === NEXT_CALLBACK_PATH ? RAILS_CALLBACK_PATH : NEXT_CALLBACK_PATH;
  const backWebhook =
    webhookPath === NEXT_WEBHOOK_PATH ? RAILS_WEBHOOK_PATH : NEXT_WEBHOOK_PATH;
  return (
    `APPLY=1 pnpm cutover repoint ${handle} --url ${fromUrl ?? "<old url>"} ` +
    `--from ${targetUrl} --callback-path ${backCallback} --webhook-path ${backWebhook}`
  );
}

/**
 * Stores digests for registrations at our url that we hold no token for.
 *
 * The recovery path, and it is a read plus a write rather than a destructive
 * re-create: the token is still readable from `api_show`, so a registration
 * whose digest we lost — a crashed cutover, a restore from a backup taken
 * before it — can simply be adopted again.
 */
async function reconcile(
  handle: string,
  targetUrl: string,
  callbackPath: string,
) {
  const company = await loadCompany(handle);
  const dri = company.dropletInstallationUuid!;
  const client = createFluidClient(company.authenticationToken);

  const live = await fluidRegistrations(client);
  const stored = await storedFor(dri);
  const heldUuids = new Set(stored.map((row) => row.uuid));
  const active = await activeCallbacks();

  // Resolved per definition against its EXACT expected destination, using the
  // same one-candidate rule repoint uses.
  //
  // The previous version accepted anything whose url merely started with the
  // target. On a shared host that adopts a sibling droplet's registration —
  // and once adopted, every later repoint reads as ambiguous, because both
  // uuids are now "held". A prefix test also accepts
  // `https://target.example.attacker.test/...`.
  const broken: Registration[] = [];
  for (const callback of active) {
    const destination = `${targetUrl}${callbackPath}`;
    const candidates = live.filter((r) => r.definition_name === callback.name);
    const ours = ourRegistration(candidates, heldUuids, [destination]);

    if (ours === "ambiguous") {
      fail(
        `  FAIL  ${callback.name}: more than one registration could be ours. ` +
          `Nothing has been changed. Resolve by hand:\n` +
          candidates.map((r) => `    ${r.uuid}  ${r.url}`).join("\n"),
      );
    }
    if (!ours || ours.url !== destination) continue;
    if (verifiablyHeld(ours, stored)) continue;
    broken.push(ours);
  }

  console.log(
    `${APPLY ? "RECONCILING" : "DRY RUN for"} ${company.fluidShop}: ` +
      `${broken.length} registration(s) at ${targetUrl}${callbackPath} are missing or stale\n`,
  );

  if (broken.length === 0) {
    console.log("  Nothing to fix: every registration at this url verifies.");
    return;
  }

  for (const registration of broken) {
    if (!APPLY) {
      console.log(
        `  WOULD ${registration.definition_name}: re-read token for ${registration.uuid}`,
      );
      continue;
    }
    try {
      await adoptToken(client, dri, registration.uuid);
      console.log(
        `  fixed ${registration.definition_name}: ${registration.uuid}`,
      );
    } catch (error) {
      fail(
        `  FAIL  ${registration.definition_name}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

async function main() {
  const [command, handle, ...rest] = process.argv.slice(2);
  const urlFlag = rest.indexOf("--url");
  const rawUrl = urlFlag >= 0 ? rest[urlFlag + 1] : process.env.FLUID_DROPLET_URL;
  // Optional, and only a hint: it lets a registration be recognised as ours
  // when we hold no digest for it yet — the first cutover of a company whose
  // callbacks Rails registered.
  const fromFlag = rest.indexOf("--from");
  const rawFrom = fromFlag >= 0 ? rest[fromFlag + 1] : undefined;
  // Required when rolling back to Rails, which serves the callback at
  // POST /get_redirect_url and the webhook at POST /webhook, while this app
  // serves POST /api/callbacks/redirect-cart-payment and POST /api/webhooks. The direction cannot be inferred from the urls, so it
  // is stated rather than guessed.
  const callbackPathFlag = rest.indexOf("--callback-path");
  const callbackPath = normalisePath(
    callbackPathFlag >= 0 ? rest[callbackPathFlag + 1] : NEXT_CALLBACK_PATH,
    "--callback-path",
  );
  const pathFlag = rest.indexOf("--webhook-path");
  const webhookPath = normalisePath(
    pathFlag >= 0 ? rest[pathFlag + 1] : NEXT_WEBHOOK_PATH,
    "--webhook-path",
  );

  if (!command || !handle) {
    fail(
      "Usage:\n" +
        "  pnpm cutover status    <fluid_shop>\n" +
        "  APPLY=1 pnpm cutover repoint   <fluid_shop> --url https://... [--from https://old]\n" +
        "                                 [--callback-path /get_redirect_url] [--webhook-path /webhook]\n" +
        "  APPLY=1 pnpm cutover reconcile <fluid_shop> --url https://... [--callback-path ...]",
    );
  }

  const fromUrl = rawFrom ? normaliseOrigin(rawFrom, "--from") : undefined;

  switch (command) {
    case "status":
      await status(handle);
      break;
    case "repoint": {
      if (!rawUrl) fail("repoint needs --url or FLUID_DROPLET_URL.");
      const url = normaliseOrigin(rawUrl, "--url");
      await repoint(handle, url, fromUrl, callbackPath, webhookPath);
      break;
    }
    case "reconcile": {
      if (!rawUrl) fail("reconcile needs --url or FLUID_DROPLET_URL.");
      const url = normaliseOrigin(rawUrl, "--url");
      await reconcile(handle, url, callbackPath);
      break;
    }
    default:
      fail(`Unknown command "${command}".`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
