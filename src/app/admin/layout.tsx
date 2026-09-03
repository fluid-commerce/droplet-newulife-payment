import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";

/**
 * Port of app/views/layouts/admin.html.erb, plus AdminController's
 * `before_action :authenticate_user!`.
 *
 * middleware.ts already redirects an unauthenticated visitor. This repeats the
 * check because the layout is where the session is actually read, and a guard
 * that lives only in middleware is one config change away from being skipped.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/admin");

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar />
      <main className="relative flex min-h-screen flex-1 flex-col">
        <Header email={session.user.email} />
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          <div className="gradient-background min-h-[100vh] flex-1 overflow-hidden rounded-xl border border-gray-200 md:min-h-min">
            <div className="mx-auto max-w-7xl space-y-12 px-10 py-8">
              <div className="space-y-8">{children}</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
