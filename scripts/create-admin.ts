/**
 * Creates the first admin user from the environment.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm setup:create-admin
 *
 * Port of `rake setup:create_admin` (lib/tasks/setup.rb). The digest it writes
 * is plain bcrypt at cost 12 with a `$2a$` prefix, which is exactly what Devise
 * writes, so the Rails app can still authenticate a user created here while the
 * two run side by side.
 */

import { prisma } from "../src/lib/db";
import { createUser } from "../src/lib/users";

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD must both be set");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (existing) {
    console.log(`Admin user for ${email} already exists`);
    await prisma.$disconnect();
    return;
  }

  const result = await createUser({
    email,
    password,
    passwordConfirmation: password,
    permissionSets: ["AdminPermissions"],
  });

  if (result.ok) {
    console.log(`Admin user for ${email} created`);
  } else {
    console.error(`Admin user for ${email} creation failed`);
    console.error(result.errors.join(", "));
    await prisma.$disconnect();
    process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
