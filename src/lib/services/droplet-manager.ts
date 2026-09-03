/**
 * Droplet Manager
 *
 * Port of app/services/droplet_manager.rb. Creates or updates this droplet's
 * record in Fluid from the `droplet`, `marketplace_page`, `details_page` and
 * `service_operational_countries` settings rows, and writes the uuid Fluid
 * assigns back into the `droplet` setting.
 */

import type { FluidClient, DropletPayload } from "@/lib/fluid";
import {
  dropletCategories,
  dropletSettings,
  requireSetting,
  mergeSettingValues,
} from "@/lib/settings";

/** Assembles the `droplet` payload Fluid expects, exactly as Rails did. */
async function dropletPayload(): Promise<DropletPayload> {
  const droplet = await requireSetting("droplet");
  const marketplacePage = await requireSetting("marketplace_page");
  const detailsPage = await requireSetting("details_page");
  const countries = await requireSetting("service_operational_countries");

  return {
    ...droplet.values,
    settings: {
      marketplace_page: marketplacePage.values,
      details_page: detailsPage.values,
      service_operational_countries: countries.values.countries,
    },
    // This droplet's own addition to the template payload — see
    // app/clients/fluid/droplets.rb, which merges `categories` alongside
    // `settings`. It is a sibling of `settings`, not a member of it.
    categories: await dropletCategories(),
  } as DropletPayload;
}

export class DropletManager {
  constructor(private readonly client: FluidClient) {}

  async create(): Promise<DropletPayload> {
    const response = await this.client.createDroplet(await dropletPayload());
    const droplet = response.droplet;

    // Rails wrote back only these four keys, discarding everything else Fluid
    // returned. Kept: `droplet` is schema-validated, and a stray field from a
    // future Fluid response would fail that validation on the next save.
    await mergeSettingValues("droplet", {
      uuid: droplet.uuid,
      name: droplet.name,
      active: droplet.active,
      embed_url: droplet.embed_url,
    });

    return droplet;
  }

  async update(): Promise<DropletPayload> {
    const { uuid } = await dropletSettings();
    if (!uuid) {
      throw new Error(
        "Cannot update a droplet that has not been created — the `droplet` setting has no uuid",
      );
    }

    const response = await this.client.updateDroplet(
      uuid,
      await dropletPayload(),
    );
    return response.droplet;
  }
}
