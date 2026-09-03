/**
 * Edge-safe Auth.js configuration.
 *
 * `middleware.ts` runs on the edge runtime, where neither Prisma nor bcrypt can
 * load. Splitting the config means middleware can read the JWT session and make
 * routing decisions while the credentials provider — which needs both — stays
 * in the Node-only src/auth.ts.
 */

import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  // JWT rather than a database session: `users` is the Rails schema and gaining
  // a sessions table would be a schema change on a live database that the Rails
  // app also owns.
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.userId = (user as { id?: string }).id;
        token.permissionSets =
          (user as { permissionSets?: string[] }).permissionSets ?? [];
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.userId as string) ?? "";
        session.user.permissionSets = (token.permissionSets as string[]) ?? [];
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
