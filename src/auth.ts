/**
 * Auth.js (NextAuth v5) — credentials against the existing Devise rows.
 *
 * Replaces Devise's `:database_authenticatable` and `:rememberable`. The other
 * Devise modules the User model declared are deliberately not reimplemented:
 *
 *  - `:registerable` — the Rails template exposed public sign-up at
 *    /users/sign_up on an internal admin console. Users are created by an
 *    admin, or by `pnpm setup:create-admin`.
 *  - `:recoverable` — password reset needs a mailer, and this app has none
 *    configured (Rails' was the unconfigured default too, so the reset mail
 *    never sent in production either). The `reset_password_token` and
 *    `reset_password_sent_at` columns are preserved so it can be added without
 *    a migration.
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "")
          .trim()
          // Devise's `case_insensitive_keys` and `strip_whitespace_keys` both
          // list :email, so it is stored downcased and trimmed.
          .toLowerCase();
        const password = String(credentials?.password ?? "");

        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await verifyPassword(password, user.encryptedPassword);
        if (!valid) return null;

        return {
          id: String(user.id),
          email: user.email,
          permissionSets: user.permissionSets,
        };
      },
    }),
  ],
});
