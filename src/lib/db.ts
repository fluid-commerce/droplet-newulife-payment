/**
 * Prisma Client Instance
 *
 * Singleton client for the droplet's own database — the same database the
 * Rails app owns. DATABASE_URL is read straight from the environment; there is
 * deliberately no fallback, because a silently-wrong default here points a
 * live droplet at the wrong tenant's data.
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
