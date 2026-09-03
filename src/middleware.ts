/**
 * Route guards.
 *
 * Replaces `before_action :authenticate_user!` on AdminController: everything
 * under /admin requires a session, and a signed-out visitor is redirected to
 * /login with a callback back to where they were going.
 *
 * The finer-grained CanCanCan checks stay where they were — in the pages and
 * route handlers, via `can()` — because middleware runs on the edge and cannot
 * read the database to find out what a subject is.
 *
 * The machine-facing routes are excluded outright, and the list is longer than
 * `/api` here because three of this droplet's endpoints deliberately keep their
 * Rails paths (see CUTOVER.md):
 *
 *   /api/*                — the Fluid webhook and callback, HMAC-authenticated
 *   /webhooks/moola/p2m   — the Moola webhook, HMAC-authenticated
 *   /checkout/success/*   — the uPayments browser return
 *
 * A session redirect in front of any of them would answer a payment processor
 * with a 307 to an HTML login page.
 *
 * /embed_ui is NOT excluded and does not need to be: only /admin is guarded, so
 * the dropzone falls through. It is a public page by design — Fluid renders it
 * in an iframe with no session of ours.
 */

import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "./auth.config";

const { auth } = NextAuth(authConfig);

export default auth((request) => {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/webhooks/") ||
    pathname.startsWith("/checkout/")
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/admin")) {
    if (!request.auth?.user) {
      const login = new URL("/login", request.nextUrl.origin);
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Everything except Next's own assets and static files.
    "/((?!_next/static|_next/image|favicon.ico|icon.png|icon.svg|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
