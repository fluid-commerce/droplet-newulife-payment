/**
 * Registration Service
 *
 * Registers the per-company webhooks declared in droplet.config.ts when a
 * company installs this droplet.
 *
 * Callbacks are registered separately, by src/lib/callbacks/registration.ts —
 * they come from the `callbacks` table and they have to persist a verification
 * token, which webhooks do not.
 */

import type { FluidClient } from "@/lib/fluid";
import type { DropletConfig, WebhookConfig } from "./schema";
import { filterEnabled } from "./schema";

export type RegistrationResults = {
  webhooks: {
    success: number;
    failed: number;
    errors: Array<{ config: WebhookConfig; error: string }>;
  };
};

async function registerWebhooks(
  client: FluidClient,
  webhooks: WebhookConfig[],
  authToken: string,
): Promise<RegistrationResults["webhooks"]> {
  const results: RegistrationResults["webhooks"] = {
    success: 0,
    failed: 0,
    errors: [],
  };

  for (const webhook of filterEnabled(webhooks)) {
    try {
      await client.createWebhook({
        resource: webhook.resource,
        event: webhook.event,
        url: `${process.env.FLUID_DROPLET_URL}/api/webhooks`,
        auth_token: authToken,
        http_method: "post",
        active: true,
      });
      results.success++;
      console.log(
        `[Registration] ✅ Webhook registered: ${webhook.resource}.${webhook.event}`,
      );
    } catch (error) {
      results.failed++;
      const message = error instanceof Error ? error.message : String(error);
      results.errors.push({ config: webhook, error: message });
      console.error(
        `[Registration] ❌ Failed to register webhook: ${webhook.resource}.${webhook.event}`,
        message,
      );
    }
  }

  return results;
}

export async function registerAllFeatures(
  client: FluidClient,
  config: DropletConfig,
  authToken: string,
): Promise<RegistrationResults> {
  return {
    webhooks: await registerWebhooks(client, config.webhooks, authToken),
  };
}
