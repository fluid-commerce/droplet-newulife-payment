import Link from "next/link";

/** Port of app/views/admin/users/_form.html.erb. */
export function UserForm({
  action,
  submitLabel,
  permissionSetNames,
  defaults,
  errors,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  permissionSetNames: string[];
  defaults: { email: string; permissionSets: string[] };
  errors?: string[];
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-white p-4">
      {errors && errors.length > 0 ? (
        <ul className="mb-4 list-disc space-y-1 rounded-md border border-red-200 bg-red-50 p-4 pl-8 text-sm text-red-700">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <form action={action}>
        <div className="mb-4 flex items-center gap-4">
          <label htmlFor="email" className="w-48 shrink-0">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={defaults.email}
            className="w-full rounded-md border border-gray-300 p-2"
          />
        </div>

        <div className="mb-4 flex items-center gap-4">
          <label htmlFor="password" className="w-48 shrink-0">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-gray-300 p-2"
          />
        </div>

        <div className="mb-4 flex items-center gap-4">
          <label htmlFor="password_confirmation" className="w-48 shrink-0">
            Confirm Password
          </label>
          <input
            id="password_confirmation"
            name="password_confirmation"
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-gray-300 p-2"
          />
        </div>

        <div className="mb-4 flex items-center gap-4">
          <label htmlFor="permission_sets" className="w-48 shrink-0">
            Permission Sets
          </label>
          <select
            id="permission_sets"
            name="permission_sets"
            multiple
            defaultValue={defaults.permissionSets}
            className="w-full rounded-md border border-gray-300 p-2"
          >
            {permissionSetNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="mr-2 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-orange-600"
        >
          {submitLabel}
        </button>
        <Link
          href="/admin/users"
          className="inline-flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-800 hover:bg-gray-300"
        >
          Cancel
        </Link>
      </form>
    </div>
  );
}
