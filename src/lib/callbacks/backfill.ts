/**
 * Adopting callback verification tokens for an installation that predates the
 * SDK, or that has been re-registered.
 *
 * The mechanism is the SDK's `backfillCallbackTokens`, wrapped in a staged swap.
 *
 * ## Why staged
 *
 * The SDK's backfill upserts as it goes and never prunes, so a registration
 * Fluid deleted and recreated leaves the dead row behind — and a check that
 * asks only "is there a row for this definition" is satisfied by that dead row
 * while every live request carries the new token and is refused.
 *
 * Deleting first fixes the pruning but opens a window in which the installation
 * has NO digests, and every callback that arrives during it is refused. On a
 * fail-open route that is a silent 200.
 *
 * So: collect the whole replacement set in memory, check it covers every
 * enabled callback, and only then delete and insert in a single transaction.
 * The installation's digests are never removed before their replacements are in
 * hand, and any failure leaves the previous set exactly as it was.
 */

import {
  backfillCallbackTokens,
  type CallbackTokenStore,
  type StoredRegistration,
} from "@fluid-app/droplet-sdk";

import { prisma } from "@/lib/db";
import type { FluidClient } from "@/lib/fluid";

/**
 * A store that collects rather than writes.
 *
 * `deleteForInstallation` is a deliberate no-op: the delete happens inside the
 * swap transaction, after the replacement set has been validated. The SDK's
 * backfill never calls it; implementing it keeps this a real CallbackTokenStore
 * rather than a cast.
 */
export function stagingStore(
  collected: StoredRegistration[],
): CallbackTokenStore {
  return {
    async findByTokenDigest() {
      return null;
    },
    async upsert(registration) {
      const index = collected.findIndex((r) => r.uuid === registration.uuid);
      if (index >= 0) collected[index] = registration;
      else collected.push(registration);
    },
    async deleteForInstallation() {
      // Intentionally nothing. See the module docstring.
    },
  };
}

export interface InstallationBackfillResult {
  ok: boolean;
  stored: number;
  foreign: number;
  skipped: number;
  /** Enabled definitions with no usable token. Non-empty means nothing was written. */
  missing: string[];
}

export async function backfillInstallation({
  client,
  dri,
  dropletUrl,
  ownUrls,
  enabledDefinitions,
}: {
  client: FluidClient;
  dri: string;
  dropletUrl: string;
  /** The exact URLs this droplet registered. Matched exactly, never by prefix. */
  ownUrls: string[];
  enabledDefinitions: string[];
}): Promise<InstallationBackfillResult> {
  const staged: StoredRegistration[] = [];

  const result = await backfillCallbackTokens({
    client,
    store: stagingStore(staged),
    dri,
    dropletUrl,
    ownUrls,
  });

  // Counting what was adopted is not enough: a re-run legitimately stores
  // nothing new, an empty listing stores nothing, and one definition arriving
  // while another is missing also stores something. The only question that
  // matters is whether EVERY enabled callback now has a usable token for THIS
  // installation — scoped to this dri, because a store-wide check would pass as
  // soon as any other company had been migrated.
  const present = new Set(staged.map((row) => row.definitionName));
  const missing = enabledDefinitions.filter((name) => !present.has(name));

  if (missing.length > 0) {
    return {
      ok: false,
      stored: 0,
      foreign: result.foreign,
      skipped: result.skipped,
      missing,
    };
  }

  await prisma.$transaction([
    prisma.fluidCallbackRegistration.deleteMany({ where: { dri } }),
    ...staged.map((row) =>
      prisma.fluidCallbackRegistration.create({ data: row }),
    ),
  ]);

  return {
    ok: true,
    stored: staged.length,
    foreign: result.foreign,
    skipped: result.skipped,
    missing: [],
  };
}
