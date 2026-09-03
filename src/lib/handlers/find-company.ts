/**
 * Locating the company a webhook payload refers to.
 *
 * Port of `WebhookEventJob#find_company` and `WebhooksController#find_company`,
 * with the droplet-wide fallback REMOVED.
 *
 * Both Ruby versions tried `company_droplet_uuid` FIRST. That column is set
 * from the payload's `droplet_uuid` (droplet_installed_job.rb:28) — i.e. THE
 * DROPLET's uuid, identical on every installation row, with a deliberately
 * non-unique index. `find_by` on it returns an arbitrary row, and the webhook
 * was then authenticated against whatever company that happened to be. It has
 * not bitten because this droplet is effectively single-tenant; it is not
 * carried forward.
 *
 * What is left is ordered by how specific it is:
 *
 *   1. `droplet_installation_uuid` — the only genuinely per-installation value.
 *   2. `fluid_company_id` — per company, but this droplet's index on it is NOT
 *      unique, so findFirst rather than findUnique.
 *
 * Returning null is correct and is treated as an auth failure by the caller.
 */

import { prisma } from "@/lib/db";

export interface CompanyIdentifiers {
  company: {
    fluid_company_id?: number | string;
    droplet_installation_uuid?: string;
  };
}

export async function findCompanyForPayload(payload: CompanyIdentifiers) {
  const { company } = payload;

  if (company.droplet_installation_uuid) {
    const match = await prisma.company.findFirst({
      where: { dropletInstallationUuid: company.droplet_installation_uuid },
    });
    if (match) return match;
  }

  if (company.fluid_company_id !== undefined) {
    return prisma.company.findFirst({
      where: { fluidCompanyId: BigInt(company.fluid_company_id) },
    });
  }

  return null;
}
