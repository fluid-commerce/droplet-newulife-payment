import Link from "next/link";

import { requirePermission } from "@/lib/auth/require";
import { ensureDefaultSettings, listSettings } from "@/lib/settings";

/** Port of app/views/admin/settings/index.html.erb. */
function humanize(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Port of ApplicationHelper#format_settings_values. */
function formatValues(values: Record<string, unknown>): string {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return "";

  const shown = entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  if (entries.length > 4) shown.push("...");
  return shown.join(", ");
}

export default async function SettingsIndexPage() {
  await requirePermission("read", "Setting");

  // Rails created these lazily on first access via Setting.method_missing.
  // Doing it here keeps a fresh database usable without a rake task, and unlike
  // the Ruby version it is not a write hidden inside an attribute read.
  await ensureDefaultSettings();
  const settings = await listSettings();

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold text-gray-600">Settings</h1>
      </div>

      <div className="rounded-lg border border-gray-100 bg-white p-6">
        <table className="w-full">
          <thead className="border-b border-gray-400 bg-slate-50">
            <tr>
              <th className="pl-2 text-left text-slate-600">Name</th>
              <th className="pl-2 text-left text-slate-600">Values</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((setting) => (
              <tr
                key={String(setting.id)}
                className="odd:bg-white even:bg-slate-50 hover:bg-slate-100"
              >
                <td className="pl-2 text-left text-gray-600">
                  <Link
                    href={`/admin/settings/${setting.id}`}
                    className="text-blue-600 hover:text-orange-600"
                  >
                    {humanize(setting.name)}
                  </Link>
                </td>
                <td className="whitespace-pre pl-2 text-left font-mono text-gray-400">
                  {formatValues(setting.values)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
