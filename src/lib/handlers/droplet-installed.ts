/**
 * Droplet Installation Handler
 *
 * Port of app/jobs/droplet_installed_job.rb.
 *
 * Fluid sends the company's credentials in this payload and nowhere else, so
 * this is where a `companies` row is created or refreshed. It then registers
 * the callbacks an operator has marked active, capturing each verification
 * token as a digest.
 */

import { z } from "zod";

import { prisma } from "@/lib/db";
import { createFluidClient } from "@/lib/fluid";
import { dropletConfig, registerAllFeatures } from "@/lib/config";
import { registerCallbacksForCompany, callbackStore } from "@/lib/callbacks";
import { dropletSettings } from "@/lib/settings";

/**
 * Fluid nests the company under `company` and names the droplet's own uuid
 * `droplet_uuid` there — which Rails then stored in `company_droplet_uuid`.
 *
 * Permissive on purpose: Fluid adds fields to this payload over time, and a
 * strict schema would turn a new field into a failed install.
 */
const installCompanySchema = z.object({
  fluid_shop: z.string(),
  name: z.string(),
  fluid_company_id: z.union([z.number(), z.string()]),
  droplet_uuid: z.string(),
  droplet_installation_uuid: z.string().optional(),
  authentication_token: z.string(),
  webhook_verification_token: z.string().optional(),
});

const installPayloadSchema = z.object({ company: installCompanySchema });

export async function handleDropletInstalled(payload: unknown): Promise<void> {
  const { company: data } = installPayloadSchema.parse(payload);

  // Guard against cross-contamination. Fluid delivers install webhooks per
  // droplet, but several droplets can share a webhook endpoint during
  // development, and a droplet that adopts another droplet's installation would
  // register callbacks against the wrong tenant.
  //
  // Rails did this in the controller (validate_droplet_authorization) and
  // rejected with a 401. Doing it here instead means the check still applies
  // when the event arrives by any other route.
  const expected = (await dropletSettings()).uuid ?? process.env.DROPLET_UUID;
  if (expected && data.droplet_uuid !== expected) {
    console.log(
      `[DropletInstalled] Ignoring — droplet_uuid ${data.droplet_uuid} is not ours (${expected})`,
    );
    return;
  }
  if (!expected) {
    console.warn(
      "[DropletInstalled] No droplet uuid configured — cannot verify this event is for this droplet",
    );
  }

  const fluidCompanyId = BigInt(data.fluid_company_id);

  // Rails matched on fluid_shop. Kept, because that is what decides whether an
  // existing production row is updated or duplicated, and `fluid_shop` has only
  // a plain index — findFirst, not findUnique.
  const existing = await prisma.company.findFirst({
    where: { fluidShop: data.fluid_shop },
  });

  const attributes = {
    fluidShop: data.fluid_shop,
    name: data.name,
    fluidCompanyId,
    authenticationToken: data.authentication_token,
    webhookVerificationToken: data.webhook_verification_token ?? null,
    dropletInstallationUuid: data.droplet_installation_uuid ?? null,
    companyDropletUuid: data.droplet_uuid,
    active: true,
    // A reinstall arrives as a fresh `droplet.installed`. Clearing this is what
    // makes the row live again; leaving it set would keep the company excluded
    // from every `uninstalledAt: null` lookup, including tenant resolution.
    uninstalledAt: null,
  };

  const company = existing
    ? await prisma.company.update({
        where: { id: existing.id },
        data: attributes,
      })
    : await prisma.company.create({ data: attributes });

  console.log(
    `[DropletInstalled] Company ${company.id} (${company.name}) installed`,
  );

  const client = createFluidClient(company.authenticationToken);

  // Per-company webhooks from droplet.config.ts. Failures are logged, not
  // fatal — Rails did not fail an install over them either.
  //
  // The `auth_token` registered here is the SHARED token, never the company's
  // own `webhook_verification_token`. Fluid echoes auth_token back as a
  // plaintext header on every delivery, and the verification token is the HMAC
  // key — putting it in a header would hand it to anyone who can see the
  // request. This route does not authenticate on that header at all; it
  // verifies the signature.
  try {
    await registerAllFeatures(
      client,
      dropletConfig,
      process.env.FLUID_WEBHOOK_AUTH_TOKEN ?? "",
    );
  } catch (error) {
    console.error(
      `[DropletInstalled] Feature registration failed for company ${company.id}:`,
      error instanceof Error ? error.message : error,
    );
  }

  const dri = company.dropletInstallationUuid ?? "";

  // A reinstall re-registers callbacks Fluid may still hold from the previous
  // installation. Clearing the stored digests first means a duplicate
  // registration cannot leave a row pointing at a token that is no longer live.
  if (dri) {
    await callbackStore.deleteForInstallation(dri).catch((error) => {
      console.warn(
        "[DropletInstalled] Could not clear previous callback tokens:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  // The uuids Fluid issued are recorded in `fluid_callback_registrations`
  // alongside each token digest, so there is nothing further to persist here —
  // see cleanupCallbacksForCompany for why this droplet has no
  // `companies.installed_callback_ids`.
  const results = await registerCallbacksForCompany(client, dri);

  if (results.failed > 0) {
    console.warn(
      `[DropletInstalled] ${results.failed} callback(s) failed to register for company ${company.id}. ` +
        "Those callbacks will be refused until they are re-registered or backfilled.",
    );
  }
}
