import type { CallbackTokenStore, StoredRegistration } from "./types";

/**
 * The delegate shape this adapter needs.
 *
 * Structural rather than importing a generated Prisma client: each droplet
 * names the model differently, and the package must not depend on any one
 * droplet's generated types.
 */
export interface PrismaCallbackDelegate {
  findUnique(args: {
    where: { tokenDigest: string };
  }): Promise<StoredRegistration | null>;
  upsert(args: {
    where: { uuid: string };
    create: StoredRegistration;
    update: Omit<StoredRegistration, "uuid">;
  }): Promise<unknown>;
  deleteMany(args: { where: { dri: string } }): Promise<unknown>;
  count(args: { where: { definitionName: { in: string[] } } }): Promise<number>;
}

/**
 * Wraps a Prisma model delegate as a CallbackTokenStore.
 *
 * Usage:
 *
 *   createPrismaCallbackStore(prisma.fluidCallbackRegistration)
 */
export function createPrismaCallbackStore(
  delegate: PrismaCallbackDelegate,
): CallbackTokenStore {
  return {
    async findByTokenDigest(digest) {
      return delegate.findUnique({ where: { tokenDigest: digest } });
    },

    async upsert(registration) {
      const { uuid, ...rest } = registration;
      await delegate.upsert({
        where: { uuid },
        create: registration,
        update: rest,
      });
    },

    async deleteForInstallation(dri) {
      await delegate.deleteMany({ where: { dri } });
    },
  };
}
