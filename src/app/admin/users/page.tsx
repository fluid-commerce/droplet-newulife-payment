import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { Flash } from "@/components/flash";
import { requirePermission } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { deleteUser } from "@/lib/users";

/** Port of app/views/admin/users/index.html.erb. */
export default async function UsersIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; alert?: string }>;
}) {
  await requirePermission("read", "User");
  const { notice, alert } = await searchParams;

  const users = await prisma.user.findMany({ orderBy: { id: "asc" } });

  async function destroy(formData: FormData) {
    "use server";
    const actor = await requirePermission("destroy", "User");

    const id = String(formData.get("id"));

    // Deleting yourself locks you out of an app whose only other way in is
    // another admin. Rails allowed it; refusing is the smaller surprise.
    if (id === actor.id) {
      redirect(
        `/admin/users?alert=${encodeURIComponent("You cannot delete your own account")}`,
      );
    }

    const user = await prisma.user.findUnique({ where: { id: BigInt(id) } });
    await deleteUser(BigInt(id));
    revalidatePath("/admin/users");
    redirect(
      `/admin/users?notice=${encodeURIComponent(`${user?.email ?? "User"} deleted successfully`)}`,
    );
  }

  return (
    <>
      <Flash notice={notice} alert={alert} />

      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold text-gray-600">Users</h1>
        <Link
          href="/admin/users/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-orange-600"
        >
          New User
        </Link>
      </div>

      <div className="rounded-lg border border-gray-100 bg-white p-6">
        <table className="w-full">
          <thead className="border-b border-gray-400 bg-slate-50">
            <tr>
              <th className="pl-2 text-left text-slate-600">ID</th>
              <th className="pl-2 text-left text-slate-600">Email</th>
              <th className="pl-2 text-left text-slate-600">Permission Sets</th>
              <th className="pl-2 text-left text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={String(user.id)}
                className="odd:bg-white even:bg-slate-50 hover:bg-slate-100"
              >
                <td className="pl-2 text-left text-gray-600">
                  {String(user.id)}
                </td>
                <td className="pl-2 text-left text-gray-600">{user.email}</td>
                <td className="pl-2 text-left text-gray-600">
                  {user.permissionSets.join(", ")}
                </td>
                <td className="pl-2 text-left text-gray-600">
                  <div className="flex items-center gap-4">
                    <Link
                      href={`/admin/users/${user.id}/edit`}
                      className="text-blue-600 hover:text-orange-600"
                    >
                      Edit
                    </Link>
                    <form action={destroy}>
                      <input
                        type="hidden"
                        name="id"
                        value={String(user.id)}
                      />
                      <button
                        type="submit"
                        className="text-blue-600 hover:text-orange-600"
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
