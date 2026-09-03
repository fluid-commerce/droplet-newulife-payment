/**
 * Server-side authorisation for admin pages and route handlers.
 *
 * Replaces CanCanCan's `authorize!` / `current_ability`. A page calls
 * `requirePermission("manage", "User")`; a subject the session's permission
 * sets do not cover gets a redirect (for a page) or a 403 (for a handler),
 * rather than being rendered and failing at the write.
 */

import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { can, type Action, type Subject } from "@/lib/permissions";

export interface CurrentUser {
  id: string;
  email: string | null | undefined;
  permissionSets: string[];
}

export async function currentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    permissionSets: session.user.permissionSets ?? [],
  };
}

/** Redirects unless the signed-in user may perform `action` on `subject`. */
export async function requirePermission(
  action: Action,
  subject: Subject,
): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) redirect("/login");

  if (!can(user, action, subject)) {
    redirect(`/admin?alert=${encodeURIComponent("Not authorized")}`);
  }

  return user;
}

/** Route-handler equivalent: returns the user, or a 401/403 Response. */
export async function authorizeRequest(
  action: Action,
  subject: Subject,
): Promise<{ user: CurrentUser } | { response: Response }> {
  const user = await currentUser();
  if (!user) {
    return {
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  if (!can(user, action, subject)) {
    return {
      response: Response.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return { user };
}
