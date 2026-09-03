/**
 * Droplet Uninstallation Handler
 *
 * Port of app/jobs/droplet_uninstalled_job.rb. Deletes the callback
 * registrations this droplet created for the company, drops their stored
 * digests, and marks the row uninstalled.
 *
 * The row is kept rather than deleted, exactly as Rails did: `events` has a
 * NOT NULL foreign key to it, and a reinstall is expected to find it again.
 */

import { z } from "zod";

import { prisma } from "@/lib/db";
import { createFluidClient } from "@/lib/fluid";
import { dropletConfig, cleanupAllFeatures } from "@/lib/config";
import { cleanupCallbacksForCompany } from "@/lib/callbacks";
import { findCompanyForPayload } from "./find-company";

// `company_droplet_uuid` is deliberately absent: it is the DROPLET's uuid,
// shared by every installation, and findCompanyForPayload no longer keys on it.
const uninstallPayloadSchema = z.object({
  company: z.object({
    fluid_company_id: z.union([z.number(), z.string()]).optional(),
    droplet_installation_uuid: z.string().optional(),
  }),
});

export async function handleDropletUninstalled(
  payload: unknown,
): Promise<void> {
  const parsed = uninstallPayloadSchema.parse(payload);
  const company = await findCompanyForPayload(parsed);

  if (!company) {
    console.warn(
      "[DropletUninstalled] Company not found for payload:",
      JSON.stringify(parsed.company),
    );
    return;
  }

  const client = createFluidClient(company.authenticationToken);

  try {
    await cleanupAllFeatures(client, dropletConfig);
  } catch (error) {
    console.error(
      "[DropletUninstalled] Feature cleanup failed:",
      error instanceof Error ? error.message : error,
    );
  }

  await cleanupCallbacksForCompany(client, company.dropletInstallationUuid);

  await prisma.company.update({
    where: { id: company.id },
    data: { uninstalledAt: new Date(), active: false },
  });

  console.log(`[DropletUninstalled] Company ${company.id} uninstalled`);
}
