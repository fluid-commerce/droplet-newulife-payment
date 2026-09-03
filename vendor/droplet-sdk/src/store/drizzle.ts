import type { CallbackTokenStore, StoredRegistration } from "./types";

/**
 * Minimal surface of the Drizzle table and database this adapter needs.
 *
 * Typed structurally so the package does not depend on a specific Drizzle
 * version or dialect, and so a Prisma-backed and a Drizzle-backed droplet can
 * use the same store interface.
 */
export interface DrizzleCallbackTable {
  uuid: unknown;
  dri: unknown;
  definitionName: unknown;
  tokenDigest: unknown;
  url: unknown;
}

export interface DrizzleLike {
  select(): {
    from(table: DrizzleCallbackTable): {
      where(condition: unknown): {
        limit(n: number): Promise<StoredRegistration[]>;
      };
    };
  };
  insert(table: DrizzleCallbackTable): {
    values(row: StoredRegistration): {
      onConflictDoUpdate(args: {
        target: unknown;
        set: Omit<StoredRegistration, "uuid">;
      }): Promise<unknown>;
    };
  };
  delete(table: DrizzleCallbackTable): {
    where(condition: unknown): Promise<unknown>;
  };
}

/** `eq` from drizzle-orm, injected so the package need not depend on it directly. */
export type EqFn = (column: unknown, value: unknown) => unknown;

/**
 * Wraps a Drizzle table as a CallbackTokenStore.
 *
 * Usage:
 *
 *   import { eq } from "drizzle-orm";
 *   createDrizzleCallbackStore(db, fluidCallbackRegistrations, eq)
 */
export function createDrizzleCallbackStore(
  db: DrizzleLike,
  table: DrizzleCallbackTable,
  eq: EqFn,
): CallbackTokenStore {
  return {
    async findByTokenDigest(digest) {
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.tokenDigest, digest))
        .limit(1);
      return rows[0] ?? null;
    },

    async upsert(registration) {
      const { uuid, ...rest } = registration;
      void uuid;
      await db
        .insert(table)
        .values(registration)
        .onConflictDoUpdate({ target: table.uuid, set: rest });
    },

    async deleteForInstallation(dri) {
      await db.delete(table).where(eq(table.dri, dri));
    },
  };
}
