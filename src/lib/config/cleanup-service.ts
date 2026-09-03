/**
 * Cleanup Service
 *
 * Removes the per-company webhooks registered on install. Fluid removes
 * webhooks itself when a droplet is uninstalled, so this is belt-and-braces.
 *
 * Callback registrations are cleaned up by
 * src/lib/callbacks/registration.ts#cleanupCallbacksForCompany, which deletes
 * by the uuids this droplet recorded at install rather than by scanning the
 * company-scoped listing — that listing also contains other droplets'
 * registrations, and matching them by definition name would delete theirs.
 */

import type { FluidClient } from "@/lib/fluid";
import type { DropletConfig } from "./schema";
import { filterEnabled } from "./schema";

export type CleanupResults = {
  webhooks: { success: number; failed: number };
};

async function cleanupWebhooks(
  client: FluidClient,
  config: DropletConfig,
): Promise<CleanupResults["webhooks"]> {
  const results = { success: 0, failed: 0 };
  const enabled = filterEnabled(config.webhooks);
  if (enabled.length === 0) return results;

  let webhooks: Awaited<ReturnType<FluidClient["listWebhooks"]>>["webhooks"];
  try {
    webhooks = (await client.listWebhooks()).webhooks ?? [];
  } catch (error) {
    console.error(
      "[Cleanup] Failed to list webhooks:",
      error instanceof Error ? error.message : error,
    );
    return results;
  }

  for (const wanted of enabled) {
    const matching = webhooks.filter(
      (w) => w.resource === wanted.resource && w.event === wanted.event,
    );
    for (const webhook of matching) {
      try {
        await client.deleteWebhook(String(webhook.id));
        results.success++;
      } catch (error) {
        results.failed++;
        console.error(
          `[Cleanup] ❌ Failed to delete webhook ${webhook.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return results;
}

export async function cleanupAllFeatures(
  client: FluidClient,
  config: DropletConfig,
): Promise<CleanupResults> {
  return { webhooks: await cleanupWebhooks(client, config) };
}
