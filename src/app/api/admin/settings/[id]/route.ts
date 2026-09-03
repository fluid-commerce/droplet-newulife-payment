/**
 * PUT /api/admin/settings/:id
 *
 * Port of Admin::SettingsController#update. Rails rendered
 * `{ success: true }` unconditionally — including when the update failed
 * validation, which is why an invalid settings save looked like it worked. This
 * reports the validation errors and answers 422 instead.
 */

import { authorizeRequest } from "@/lib/auth/require";
import { updateSettingValues } from "@/lib/settings";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authorized = await authorizeRequest("update", "Setting");
  if ("response" in authorized) return authorized.response;

  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ errors: ["Body was not valid JSON"] }, { status: 400 });
  }

  const values = (body as { setting?: { values?: unknown } })?.setting?.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return Response.json(
      { errors: ["setting.values must be an object"] },
      { status: 400 },
    );
  }

  const result = await updateSettingValues(
    BigInt(id),
    values as Record<string, unknown>,
  );

  if (!result.valid) {
    return Response.json({ success: false, errors: result.errors }, { status: 422 });
  }

  return Response.json({ success: true });
}
