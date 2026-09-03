"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Form from "@rjsf/core";
import type { RJSFSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";

/**
 * JSON-Schema settings editor.
 *
 * Port of app/frontend/entrypoints/settings.tsx and components/JsonEditor.tsx.
 * The schema comes from the settings row itself, so this component works for
 * every row without knowing anything about any of them.
 *
 * Client-side validation is a convenience only — PUT /api/admin/settings/[id]
 * validates against the same schema server-side before writing, because a
 * browser-side validator is not an authorisation boundary.
 */
export function SettingsEditor({
  settingId,
  schema,
  initialData,
}: {
  settingId: string;
  schema: Record<string, unknown>;
  initialData: Record<string, unknown>;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function onSubmit({ formData }: { formData?: unknown }) {
    setSaving(true);
    setErrors([]);

    const response = await fetch(`/api/admin/settings/${settingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setting: { values: formData } }),
    });

    setSaving(false);

    if (response.ok) {
      router.push("/admin/settings");
      router.refresh();
      return;
    }

    const body = await response.json().catch(() => ({}));
    setErrors(body.errors ?? ["Could not save these settings."]);
  }

  return (
    <div className="rounded-lg border border-gray-100 bg-white p-6">
      {errors.length > 0 ? (
        <ul className="mb-4 list-disc space-y-1 rounded-md border border-red-200 bg-red-50 p-4 pl-8 text-sm text-red-700">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <Form
        schema={schema as RJSFSchema}
        formData={initialData}
        validator={validator}
        onSubmit={onSubmit}
        disabled={saving}
      >
        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <Link
            href="/admin/settings"
            className="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-800 hover:bg-gray-300"
          >
            Cancel
          </Link>
        </div>
      </Form>
    </div>
  );
}
