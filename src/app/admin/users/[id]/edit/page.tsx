import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { UserForm } from "@/components/user-form";
import { requirePermission } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { PERMISSION_SET_NAMES } from "@/lib/permissions";
import { updateUser, userInputFrom } from "@/lib/users";

/** Port of app/views/admin/users/edit.html.erb. */
export default async function EditUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ errors?: string }>;
}) {
  await requirePermission("update", "User");

  const { id } = await params;
  const { errors } = await searchParams;
  if (!/^\d+$/.test(id)) notFound();

  const user = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!user) notFound();

  async function update(formData: FormData) {
    "use server";
    await requirePermission("update", "User");

    const result = await updateUser(BigInt(id), userInputFrom(formData));

    if (!result.ok) {
      redirect(
        `/admin/users/${id}/edit?errors=${encodeURIComponent(result.errors.join(", "))}`,
      );
    }

    revalidatePath("/admin/users");
    redirect(
      `/admin/users?notice=${encodeURIComponent("User updated successfully")}`,
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold text-gray-600">Edit User</h1>
      </div>

      <UserForm
        action={update}
        submitLabel="Update"
        permissionSetNames={PERMISSION_SET_NAMES}
        defaults={{
          email: user.email,
          permissionSets: user.permissionSets,
        }}
        errors={errors ? errors.split(", ") : undefined}
      />
    </>
  );
}
