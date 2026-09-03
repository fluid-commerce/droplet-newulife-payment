import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Flash } from "@/components/flash";
import { requirePermission } from "@/lib/auth/require";
import { dropletSettings } from "@/lib/settings";
import { createDroplet, updateDroplet } from "@/lib/use-cases/droplet";

/** Port of app/views/admin/dashboard/index.html.erb. */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; alert?: string }>;
}) {
  await requirePermission("read", "Dashboard");
  const { notice, alert } = await searchParams;
  const droplet = await dropletSettings();

  async function submit(formData: FormData) {
    "use server";
    await requirePermission("manage", "Droplet");

    const intent = String(formData.get("intent"));
    const result =
      intent === "update" ? await updateDroplet() : await createDroplet();

    revalidatePath("/admin");

    if (result.success) {
      redirect(
        `/admin?notice=${encodeURIComponent(
          intent === "update"
            ? "Droplet updated successfully"
            : "Droplet created successfully",
        )}`,
      );
    }
    redirect(
      `/admin?alert=${encodeURIComponent(
        `Failed to ${intent} droplet: ${result.error}`,
      )}`,
    );
  }

  return (
    <>
      <Flash notice={notice} alert={alert} />

      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold text-gray-600">Dashboard</h1>
      </div>

      <form action={submit}>
        <input
          type="hidden"
          name="intent"
          value={droplet.uuid ? "update" : "create"}
        />
        <button
          type="submit"
          className="mr-2 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-orange-600"
        >
          {droplet.uuid ? "Update Droplet" : "Create Droplet"}
        </button>
      </form>

      {droplet.uuid ? (
        <p className="font-mono text-sm text-gray-400">uuid: {droplet.uuid}</p>
      ) : null}
    </>
  );
}
