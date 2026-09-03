/**
 * Copies callback verification tokens out of Fluid for every installation.
 *
 *   pnpm backfill:callbacks
 *
 * This droplet cannot verify a callback until it holds a digest of that
 * registration's token, and there is no unverified path — an unverified request
 * is refused, and on a fail-open route a refusal is a silent 200. So this has to
 * run, and exit zero, BEFORE the callback routes go live for an installation
 * that predates them.
 *
 * Run it by hand, from a terminal whose DATABASE_URL and FLUID_DROPLET_URL point
 * at this droplet's production values. It is deliberately not part of the deploy
 * workflow: that job holds the database secret but not per-installation Fluid
 * credentials, and a partial backfill inside CI would let the deploy proceed
 * anyway, which is the failure this ordering exists to prevent.
 *
 * Safe to re-run, and it must be re-run whenever a callback is destroyed and
 * re-registered — the only way a verification_token changes, since on fluid
 * master the token is written once by `before_create :set_tokens` and the update
 * action will not accept the field.
 *
 * The staging and swap logic lives in src/lib/callbacks/backfill.ts, where it is
 * unit tested; this file is the CLI around it.
 */

import { prisma } from "../src/lib/db";
import { createFluidClient } from "../src/lib/fluid";
import { backfillInstallation } from "../src/lib/callbacks";
import { callbackUrl, dropletConfig, filterEnabled } from "../src/lib/config";

async function main() {
  const dropletUrl = process.env.FLUID_DROPLET_URL;
  if (!dropletUrl) {
    console.error(
      "FLUID_DROPLET_URL is required — it is what tells our registrations " +
        "apart from other droplets installed for the same company.",
    );
    process.exit(1);
  }

  // This droplet has no `callbacks` table, so the enabled set comes from
  // src/lib/config/droplet.config.ts. `ownUrls` is built the same way the
  // registration built them, so the strings match EXACTLY — the listing is
  // company-scoped and matching by origin would adopt another droplet's
  // registration of the same definition on this host.
  const enabled = filterEnabled(dropletConfig.callbacks);
  if (enabled.length === 0) {
    console.log("No enabled callbacks configured; nothing to backfill.");
    await prisma.$disconnect();
    return;
  }

  const ownUrls = enabled.map((callback) => callbackUrl(callback, dropletUrl));
  const enabledDefinitions = enabled.map((callback) => callback.definitionName);

  const companies = await prisma.company.findMany({
    where: { active: true, uninstalledAt: null },
  });

  console.log(
    `Backfilling ${companies.length} active installation(s) for ` +
      `${enabled.length} callback(s): ${enabledDefinitions.join(", ")}`,
  );

  let failed = 0;

  for (const company of companies) {
    const dri = company.dropletInstallationUuid;
    if (!dri) {
      console.warn(`  SKIP  ${company.id}: no droplet_installation_uuid`);
      failed++;
      continue;
    }

    try {
      const result = await backfillInstallation({
        client: createFluidClient(company.authenticationToken),
        dri,
        dropletUrl,
        ownUrls,
        enabledDefinitions,
      });

      if (result.ok) {
        console.log(
          `  ok    ${company.id}: stored=${result.stored} ` +
            `foreign=${result.foreign} skipped=${result.skipped}`,
        );
      } else {
        failed++;
        console.error(
          `  FAIL  ${company.id}: no token for ${result.missing.join(", ")} ` +
            `(foreign=${result.foreign} skipped=${result.skipped}) — nothing was swapped, ` +
            `the previous digests are untouched`,
        );
      }
    } catch (error) {
      failed++;
      console.error(
        `  FAIL  ${company.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await prisma.$disconnect();

  if (failed > 0) {
    console.error(
      `\n${failed} installation(s) did not backfill cleanly. Their callbacks ` +
        `will be refused — and refusals answer 200, so nothing else will report it.`,
    );
    process.exit(1);
  }

  console.log("\nAll installations backfilled.");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
