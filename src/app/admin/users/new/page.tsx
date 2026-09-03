import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { UserForm } from "@/components/user-form";
import { requirePermission } from "@/lib/auth/require";
import { PERMISSION_SET_NAMES } from "@/lib/permissions";
import { createUser, userInputFrom } from "@/lib/users";

/** Port of app/views/admin/users/new.html.erb. */
export default async function NewUserPage({
  searchParams,
}: {
  searchParams: Promise<{ errors?: string; email?: string }>;
}) {
  await requirePermission("create", "User");
  const { errors, email } = await searchParams;

  async function create(formData: FormData) {
    "use server";
    await requirePermission("create", "User");

    const input = userInputFrom(formData);
    const result = await createUser(input);

    if (!result.ok) {
      // The password is deliberately not carried back in the query string.
      redirect(
        `/admin/users/new?errors=${encodeURIComponent(result.errors.join(", "))}` +
          `&email=${encodeURIComponent(input.email)}`,
      );
    }

    revalidatePath("/admin/users");
    redirect(
      `/admin/users?notice=${encodeURIComponent("User created successfully")}`,
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold text-gray-600">New User</h1>
      </div>

      <UserForm
        action={create}
        submitLabel="Create"
        permissionSetNames={PERMISSION_SET_NAMES}
        defaults={{ email: email ?? "", permissionSets: [] }}
        errors={errors ? errors.split(", ") : undefined}
      />
    </>
  );
}
