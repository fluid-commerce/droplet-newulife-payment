/**
 * Droplet configuration schema.
 *
 * Declares the callbacks and per-company webhooks this droplet registers on
 * install.
 *
 * Callbacks are declared here rather than in a `callbacks` table because this
 * droplet's database has no such table — see ./droplet.config.ts. Dropzones are
 * not declared at all: the Rails app registers none, and Fluid's
 * `/api/drop_zones` endpoints are real but were never used here.
 */

import { z } from "zod";

export const callbackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * A `name:` from one of fluid's app/lib/callback_definitions/*.yml files.
   *
   * NOT a route name and NOT a local label. Fluid matches on this exactly; a
   * value that is not in that directory registers something Fluid never calls,
   * and because callback routes answer 200 on every failure, nothing surfaces.
   */
  definitionName: z.string(),
  /** Path appended to FLUID_DROPLET_URL. The url registered with Fluid. */
  path: z.string().startsWith("/"),
  /** Fluid rejects anything over 20. */
  timeoutInSeconds: z.number().int().positive().max(20),
});

export type CallbackConfig = z.infer<typeof callbackConfigSchema>;

export const webhookConfigSchema = z.object({
  enabled: z.boolean().default(true),
  resource: z.string().describe("Resource type (e.g. 'order', 'cart')"),
  event: z.string().describe("Event name (e.g. 'created', 'external_id_synced')"),
  description: z.string().optional(),
});

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

export const dropletConfigSchema = z.object({
  callbacks: z.array(callbackConfigSchema).default([]),
  webhooks: z.array(webhookConfigSchema).default([]),
});

export type DropletConfig = z.infer<typeof dropletConfigSchema>;

export function validateConfig(config: unknown): DropletConfig {
  return dropletConfigSchema.parse(config);
}

export function filterEnabled<T extends { enabled: boolean }>(items: T[]): T[] {
  return items.filter((item) => item.enabled);
}

/**
 * The absolute url a callback is registered at.
 *
 * Exported because the backfill has to match `ownUrls` EXACTLY rather than by
 * origin: `GET /api/callback/registrations` is company-scoped and returns other
 * droplets' registrations with no owner filter, and `owner_id` cannot
 * discriminate. Another droplet registering `redirect_cart_payment` at any path
 * on this host would otherwise be adopted, because the wrapper matches on
 * definition name.
 */
export function callbackUrl(
  callback: CallbackConfig,
  dropletUrl = process.env.FLUID_DROPLET_URL ?? "",
): string {
  return `${dropletUrl.replace(/\/$/, "")}${callback.path}`;
}
