import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { SettingsEditor } from "@/components/settings-editor";

/**
 * Port of app/views/admin/settings/edit.html.erb.
 *
 * Rails handed the JSON Schema to a react-jsonschema-form widget mounted via
 * Vite; the same widget renders here as a client component fed by this server
 * component.
 */
export default async function EditSettingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("update", "Setting");

  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();

  const setting = await prisma.setting.findUnique({ where: { id: BigInt(id) } });
  if (!setting) notFound();

  const title = setting.name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold text-gray-600">{title}</h1>
          <h3 className="text-gray-400">{setting.description}</h3>
        </div>
      </div>

      <SettingsEditor
        settingId={String(setting.id)}
        schema={(setting.schema ?? {}) as Record<string, unknown>}
        initialData={(setting.values ?? {}) as Record<string, unknown>}
      />
    </>
  );
}
