/**
 * Registering this droplet's callbacks with Fluid, for one installation.
 *
 * This is NET-NEW rather than a port. The Rails app registers its one callback
 * by hand, with the curl in callbacks_registration.md, and stores no token —
 * there is no callbacks table, no sync service and no registration code to port
 * from. That is also why the callback route is unauthenticated today: nothing
 * has ever held a verification token to check against.
 *
 * ## The token is issued exactly once
 *
 * Fluid sets `verification_token` in `before_create :set_tokens` and the update
 * action refuses the field, so it appears in the CREATE response and nowhere
 * else. It cannot be re-read and it cannot be rotated.
 *
 * Discarding it therefore leaves a live registration this droplet can never
 * verify — and because `redirect_cart_payment` is checkout-blocking and answers
 * 200 on every failure, the symptom is silence: every genuine callback refused,
 * no status code changes, nothing alerts. So: capture it, store only
 * `tokenDigest(...)`, and if either step fails, delete the registration that
 * was just created.
 */

import { tokenDigest } from "@fluid-app/droplet-sdk";

import type { FluidClient } from "@/lib/fluid";
import { prisma } from "@/lib/db";
import { callbackUrl, dropletConfig, filterEnabled } from "@/lib/config";
import { callbackStore } from "./store";

export interface CallbackRegistrationResults {
  success: number;
  failed: number;
  registeredUuids: string[];
  errors: Array<{ definitionName: string; error: string }>;
}

/**
 * The callbacks this droplet registers, as `{ name, url, timeoutInSeconds }`.
 *
 * The sibling droplets read this from their `callbacks` table; here it comes
 * from src/lib/config/droplet.config.ts, which is the only place a definition
 * name is written down. The url is absolute and is the EXACT string registered
 * with Fluid, which is what lets the backfill and the cutover tool tell our
 * registrations apart from another droplet's on the same host.
 */
export function activeCallbacks(): Array<{
  name: string;
  url: string;
  timeoutInSeconds: number;
}> {
  return filterEnabled(dropletConfig.callbacks).map((callback) => ({
    name: callback.definitionName,
    url: callbackUrl(callback),
    timeoutInSeconds: callback.timeoutInSeconds,
  }));
}

/**
 * Deletes a registration Fluid has already created, after this droplet failed
 * to record the token that makes it verifiable.
 *
 * Never throws: the caller is already failing, and a rollback failure must not
 * mask the original error. Worst case is a live registration this droplet
 * cannot verify — say so loudly, because the backfill is the recovery path.
 */
async function rollbackRegistration(
  client: FluidClient,
  uuid: string,
): Promise<void> {
  try {
    await client.deleteCallback(uuid);
  } catch (cleanupError) {
    console.error(
      `[Registration] Could not roll back callback ${uuid}; ` +
        "it must be backfilled or deleted manually",
      cleanupError instanceof Error ? cleanupError.message : cleanupError,
    );
  }
}

/**
 * Registers every enabled callback for one installation, storing a digest of
 * each returned verification token.
 *
 * @param dri - the installation's `droplet_installation_uuid`. Required: it is
 *              the only thing that later binds a verified signature to a
 *              tenant, so a blank one would store rows nothing can resolve.
 */
export async function registerCallbacksForCompany(
  client: FluidClient,
  dri: string,
): Promise<CallbackRegistrationResults> {
  const results: CallbackRegistrationResults = {
    success: 0,
    failed: 0,
    registeredUuids: [],
    errors: [],
  };

  if (!dri) {
    console.error(
      "[Registration] Refusing to register callbacks without a droplet_installation_uuid; " +
        "a stored token that cannot be resolved to a tenant is worse than none",
    );
    return results;
  }

  for (const callback of filterEnabled(dropletConfig.callbacks)) {
    const { definitionName } = callback;
    try {
      const url = callbackUrl(callback);
      console.log(`[Registration] Registering callback: ${definitionName}`);

      const response = await client.createCallback({
        definition_name: definitionName,
        url,
        timeout_in_seconds: callback.timeoutInSeconds,
        active: true,
      });

      const registration = response?.callback_registration;

      // Without a uuid there is nothing addressable to roll back — Fluid did
      // not say what it created, so bail before claiming success.
      if (!registration?.uuid) {
        throw new Error(
          `Fluid returned no registration uuid for ${definitionName}`,
        );
      }

      // From here a LIVE registration exists. Every failure below has to remove
      // it, or this droplet holds a callback it can never verify.
      if (!registration.verification_token) {
        await rollbackRegistration(client, registration.uuid);
        throw new Error(
          `Fluid returned no verification_token for ${definitionName}; ` +
            "refusing to leave an unverifiable registration in place",
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
      } catch (persistError) {
        await rollbackRegistration(client, registration.uuid);
        throw persistError;
      }

      results.success++;
      results.registeredUuids.push(registration.uuid);
      console.log(`[Registration] Callback registered: ${definitionName}`);
    } catch (error) {
      results.failed++;
      const message = error instanceof Error ? error.message : String(error);
      results.errors.push({ definitionName, error: message });
      console.error(
        `[Registration] Failed to register callback: ${definitionName}`,
        message,
      );
    }
  }

  return results;
}

/**
 * Deletes the callback registrations created for one installation, and the
 * stored digests that went with them.
 *
 * The uuids come from `fluid_callback_registrations` keyed on `dri` — the rows
 * this droplet wrote when it registered them. NOT from a Fluid listing: that
 * endpoint is company-scoped and also returns other droplets' registrations,
 * and matching those by definition name would delete theirs.
 *
 * The template reads them from `companies.installed_callback_ids`; that column
 * does not exist in this database and adding one to a live Rails-owned table to
 * hold a list this app already has would be a migration for nothing.
 */
export async function cleanupCallbacksForCompany(
  client: FluidClient,
  dri: string | null,
): Promise<void> {
  if (!dri) return;

  let registrations: Array<{ uuid: string }> = [];
  try {
    registrations = await prisma.fluidCallbackRegistration.findMany({
      where: { dri },
      select: { uuid: true },
    });
  } catch (error) {
    console.error(
      "[Cleanup] Could not read stored callback registrations; " +
        "Fluid may keep registrations this droplet no longer serves",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  for (const { uuid } of registrations) {
    try {
      await client.deleteCallback(uuid);
    } catch (error) {
      console.error(
        `[Cleanup] Failed to delete callback ${uuid}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Drop this installation's stored digests.
  //
  // Without this they outlive the registrations deleted above, and a stale row
  // whose dri no longer matches an active company turns a genuine later request
  // into resolvePrincipal -> null -> auth failure, which on this fail-open route
  // is a silent 200 and a checkout that cannot be paid for.
  try {
    await callbackStore.deleteForInstallation(dri);
  } catch (error) {
    console.warn(
      "[Cleanup] Could not clear stored callback tokens; they will be " +
        "overwritten on reinstall but are stale until then",
      error instanceof Error ? error.message : error,
    );
  }
}
