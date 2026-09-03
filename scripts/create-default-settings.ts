/**
 * Creates any missing default settings rows.
 *
 *   pnpm settings:defaults
 *
 * Port of `rake settings:create_defaults`. Idempotent, and never overwrites an
 * operator's edited values.
 */

import { prisma } from "../src/lib/db";
import { ensureDefaultSettings, listSettings } from "../src/lib/settings";

async function main() {
  await ensureDefaultSettings();
  const settings = await listSettings();
  console.log(`Settings present: ${settings.map((s) => s.name).join(", ")}`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
