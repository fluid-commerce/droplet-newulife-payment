/**
 * Settings
 *
 * Port of the Rails `Setting` model plus its `method_missing` accessors
 * (`Setting.fluid_api.api_key`). Ruby resolved those names at runtime; here
 * they are named functions, because a typed accessor that cannot exist is a
 * compile error rather than a 500 in production.
 *
 * Validation matches Rails: the row's `schema` column is a JSON Schema and the
 * `values` column must satisfy it. Rails used json_schemer against the OpenAPI
 * 3.1 dialect; Ajv 2020-12 is the closest equivalent that runs here, and the
 * schemas this template ships validate identically under both.
 */

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { SETTING_DEFAULTS, REMOVABLE_DEFAULT_NAMES } from "./defaults";

export { SETTING_DEFAULTS, REMOVABLE_DEFAULT_NAMES };
export type { SettingDefault } from "./defaults";

export type SettingValues = Record<string, unknown>;

export interface SettingRecord {
  id: bigint;
  name: string;
  description: string | null;
  values: SettingValues;
  schema: Record<string, unknown>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/**
 * Compiles (and caches) a validator for a settings row's schema.
 *
 * Rails rescued json_schemer's errors and turned an unusable schema into a
 * validation failure rather than a crash; the same is done here.
 */
function compile(schema: Record<string, unknown>): ValidateFunction | null {
  try {
    return ajv.compile(schema);
  } catch (error) {
    console.error(
      "[Settings] Error compiling schema:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validates a set of values against a settings row's JSON Schema. */
export function validateValues(
  schema: Record<string, unknown>,
  values: unknown,
): ValidationResult {
  const validate = compile(schema);
  if (!validate) return { valid: false, errors: ["schema is invalid"] };

  if (validate(values)) return { valid: true, errors: [] };

  return {
    valid: false,
    errors: (validate.errors ?? []).map(
      (e) => `${e.instancePath || "values"} ${e.message ?? "is invalid"}`.trim(),
    ),
  };
}

function toRecord(row: {
  id: bigint;
  name: string;
  description: string | null;
  values: unknown;
  schema: unknown;
}): SettingRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    values: (row.values ?? {}) as SettingValues,
    schema: (row.schema ?? {}) as Record<string, unknown>,
  };
}

/**
 * Creates any missing default settings rows.
 *
 * Rails did this lazily from `Setting.method_missing` when the table was empty.
 * Doing it lazily inside a request is a write on a read path and races between
 * two concurrent requests, so it is an explicit call here — run by
 * `pnpm settings:defaults`, and by the install handler before it needs them.
 */
export async function ensureDefaultSettings(): Promise<void> {
  for (const preset of SETTING_DEFAULTS) {
    await prisma.setting.upsert({
      where: { name: preset.name },
      // Only ever fills in what is missing. An operator's edited values are
      // never overwritten by a redeploy.
      update: {},
      create: {
        name: preset.name,
        description: preset.description,
        schema: preset.schema as object,
        values: preset.values as object,
      },
    });
  }
}

/** Removes the default rows Rails' `settings:remove_defaults` task removes. */
export async function removeDefaultSettings(): Promise<number> {
  const { count } = await prisma.setting.deleteMany({
    where: { name: { in: REMOVABLE_DEFAULT_NAMES } },
  });
  return count;
}

/** Reads one settings row by name, or null when it has not been created yet. */
export async function getSetting(name: string): Promise<SettingRecord | null> {
  const row = await prisma.setting.findUnique({ where: { name } });
  return row ? toRecord(row) : null;
}

/**
 * Reads one settings row by name, creating it from the shipped default first
 * if it is missing. Throws when the name is not one this droplet knows about —
 * a typo should not silently read as an empty settings object.
 */
export async function requireSetting(name: string): Promise<SettingRecord> {
  const existing = await getSetting(name);
  if (existing) return existing;

  const preset = SETTING_DEFAULTS.find((d) => d.name === name);
  if (!preset) throw new Error(`Unknown setting: ${name}`);

  await ensureDefaultSettings();
  const created = await getSetting(name);
  if (!created) throw new Error(`Could not create setting: ${name}`);
  return created;
}

export async function listSettings(): Promise<SettingRecord[]> {
  const rows = await prisma.setting.findMany({ orderBy: { name: "asc" } });
  return rows.map(toRecord);
}

/** Replaces a settings row's values, validating against its own schema first. */
export async function updateSettingValues(
  id: bigint,
  values: SettingValues,
): Promise<ValidationResult> {
  const row = await prisma.setting.findUnique({ where: { id } });
  if (!row) return { valid: false, errors: ["setting not found"] };

  const result = validateValues(
    (row.schema ?? {}) as Record<string, unknown>,
    values,
  );
  if (!result.valid) return result;

  // `values` is Record<string, unknown>; Prisma wants its InputJsonValue. The
  // cast is safe because the value has just been validated against the row's
  // own JSON Schema, so it is JSON by construction.
  await prisma.setting.update({
    where: { id },
    data: { values: values as Prisma.InputJsonValue },
  });
  return result;
}

/**
 * Merges keys into a settings row's values without discarding the rest.
 *
 * Used by the droplet and webhook managers, which each own only a couple of
 * keys inside a shared row (`droplet.uuid`, `fluid_webhook.webhook_*_id`).
 */
export async function mergeSettingValues(
  name: string,
  patch: SettingValues,
): Promise<SettingRecord> {
  const row = await requireSetting(name);
  const values = { ...row.values, ...patch };

  const result = validateValues(row.schema, values);
  if (!result.valid) {
    throw new Error(
      `Refusing to write invalid values to setting "${name}": ${result.errors.join(", ")}`,
    );
  }

  const updated = await prisma.setting.update({
    where: { id: row.id },
    data: { values: values as Prisma.InputJsonValue },
  });
  return toRecord(updated);
}

// --- Named accessors, replacing Ruby's Setting.<name>.<key> ---------------

export interface FluidApiSettings {
  base_url: string;
  api_key: string;
}

export async function fluidApiSettings(): Promise<FluidApiSettings> {
  const { values } = await requireSetting("fluid_api");
  return {
    base_url: String(values.base_url ?? "https://api.fluid.com"),
    api_key: String(values.api_key ?? ""),
  };
}

export interface DropletSettings {
  name: string;
  embed_url: string | null;
  uuid?: string;
  active: boolean;
}

export async function dropletSettings(): Promise<DropletSettings> {
  const { values } = await requireSetting("droplet");
  return {
    name: String(values.name ?? ""),
    embed_url: (values.embed_url as string | null) ?? null,
    uuid: values.uuid ? String(values.uuid) : undefined,
    active: Boolean(values.active),
  };
}

/**
 * `categories`.
 *
 * This droplet's own settings row, in place of the template's `fluid_webhook`.
 * It feeds the droplet payload sent to Fluid — see src/lib/services/droplet-manager.ts.
 */
export async function dropletCategories(): Promise<string[]> {
  const { values } = await requireSetting("categories");
  return Array.isArray(values.categories)
    ? (values.categories as string[])
    : [];
}

export async function hostServerBaseUrl(): Promise<string> {
  const { values } = await requireSetting("host_server");
  return String(values.base_url ?? "http://localhost:3000");
}
