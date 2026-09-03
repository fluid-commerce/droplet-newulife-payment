/**
 * Default Settings
 *
 * Port of `Tasks::Settings.create_defaults` (lib/tasks/settings.rb). Each entry
 * is a row in the `settings` table: a JSON Schema plus values validated against
 * it. The schemas are byte-for-byte the same shapes the Rails task creates, so
 * a database seeded by either app is readable by the other.
 */

export interface SettingDefault {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
}

export const SETTING_DEFAULTS: SettingDefault[] = [
  {
    name: "host_server",
    description: "Settings for the hosting server",
    schema: {
      type: "object",
      required: ["base_url"],
      properties: {
        base_url: { type: "string" },
      },
    },
    values: {
      base_url: "http://localhost:3000",
    },
  },
  {
    name: "fluid_api",
    description: "Settings for the Fluid API",
    schema: {
      type: "object",
      properties: {
        base_url: { type: "string", format: "uri" },
        api_key: { type: "string" },
      },
    },
    values: {
      base_url: "https://api.fluid.com",
      api_key: "change-me",
    },
  },
  {
    name: "droplet",
    description:
      "General settings for the Droplet. The UUID is automatically set when the Droplet is created.",
    schema: {
      type: "object",
      required: ["name", "embed_url", "active"],
      properties: {
        name: { type: "string" },
        embed_url: { type: ["string", "null"] },
        uuid: { type: "string" },
        active: { type: "boolean" },
      },
    },
    values: {
      name: "Placeholder",
      embed_url: "https://example.com",
      active: true,
    },
  },
  {
    name: "marketplace_page",
    description: "Values for the Droplet Marketplace Page",
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        logo_url: { type: ["string", "null"] },
        summary: { type: ["string", "null"] },
      },
    },
    values: { title: "Placeholder" },
  },
  {
    name: "details_page",
    description: "Values for the Droplet Details Page",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        logo_url: { type: ["string", "null"] },
        summary: { type: ["string", "null"] },
        features: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              summary: { type: ["string", "null"] },
              details: { type: ["string", "null"] },
              image_url: { type: ["string", "null"] },
              video_url: { type: ["string", "null"] },
            },
            required: ["name"],
          },
        },
      },
      required: ["title"],
    },
    values: { title: "Placeholder" },
  },
  {
    name: "service_operational_countries",
    description:
      "Countries where the service is operational (ISO Country Codes). Leave blank if the Droplet is available worldwide.",
    schema: {
      type: "object",
      properties: {
        countries: { type: "array", items: { type: "string" } },
      },
    },
    values: { countries: [] },
  },
  {
    // This droplet REPLACED the template's `fluid_webhook` row with this one
    // (lib/tasks/settings.rb). There is no `fluid_webhook` setting here and no
    // WebhookManager: the two droplet-level lifecycle webhooks are created from
    // Fluid's own droplet settings screen, not from this app.
    name: "categories",
    description: "Categories for the Droplet",
    schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" } },
      },
    },
    values: { categories: ["payments"] },
  },
];

/** Names Rails' `remove_defaults` task deletes — host_server is deliberately kept. */
export const REMOVABLE_DEFAULT_NAMES = [
  "fluid_api",
  "droplet",
  "marketplace_page",
  "details_page",
  "service_operational_countries",
];
