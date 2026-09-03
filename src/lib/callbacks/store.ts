/**
 * Callback verification token store and tenant resolution.
 *
 * The store is the SDK's Prisma adapter over `fluid_callback_registrations`.
 * Only the sha256 digest of each `cvt_` token is kept, so a dump of this
 * database yields no working callback credentials.
 */

import { createPrismaCallbackStore } from "@fluid-app/droplet-sdk/prisma";
import type { StoredRegistration } from "@fluid-app/droplet-sdk";

import { prisma } from "@/lib/db";

export type CallbackPrincipal = NonNullable<
  Awaited<ReturnType<typeof prisma.company.findFirst>>
>;

export const callbackStore = createPrismaCallbackStore(
  prisma.fluidCallbackRegistration,
);

/**
 * Resolves the tenant for a verified callback, from the registration alone.
 *
 * There is deliberately no header or payload fallback. A valid signature proves
 * only *which registration* signed, not who the request is about — so trusting
 * `x-fluid-shop`, or `company.fluid_company_id` out of the body, would let the
 * holder of tenant A's token sign a request naming tenant B and be served as B.
 * Those fallbacks would fire exactly when the binding is weakest, which is when
 * guessing is least defensible.
 *
 * Note the lookup is `findFirst`, not `findUnique`: Rails put a plain index on
 * `companies.droplet_installation_uuid`, not a unique one, and the schema keeps
 * that faithfully.
 *
 * Returning null is an auth failure, and is the correct outcome.
 */
export async function resolvePrincipal({
  registration,
}: {
  registration: StoredRegistration;
  payload: unknown;
  headers: Headers;
}): Promise<CallbackPrincipal | null> {
  if (!registration.dri) return null;

  return prisma.company.findFirst({
    where: {
      dropletInstallationUuid: registration.dri,
      active: true,
      uninstalledAt: null,
    },
  });
}
