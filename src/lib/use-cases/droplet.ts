/**
 * Droplet create / update use cases.
 *
 * Port of `Admin::DropletsController#create` / `#update` — the two actions
 * behind the admin dashboard's "Create Droplet" / "Update Droplet" buttons.
 *
 * This droplet has no `DropletUseCase` classes and no `WebhookManager`; it
 * forked from an older template. The two droplet-level lifecycle webhooks
 * (`droplet.installed`, `droplet.uninstalled`) are created on Fluid's own
 * droplet settings screen rather than from here, which is also why cutting them
 * over is a manual step in CUTOVER.md.
 */

import { createFluidClient } from "@/lib/fluid";
import { fluidApiSettings } from "@/lib/settings";
import { DropletManager } from "@/lib/services/droplet-manager";

export type UseCaseResult<T> =
  | ({ success: true } & T)
  | { success: false; error: string };

async function dropletManager() {
  const { api_key, base_url } = await fluidApiSettings();
  return new DropletManager(createFluidClient(api_key, base_url));
}

export async function createDroplet(): Promise<UseCaseResult<{ droplet: unknown }>> {
  try {
    const droplet = await (await dropletManager()).create();
    return { success: true, droplet };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function updateDroplet(): Promise<UseCaseResult<{ droplet: unknown }>> {
  try {
    const droplet = await (await dropletManager()).update();
    return { success: true, droplet };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
