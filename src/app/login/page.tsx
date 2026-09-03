import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";

/**
 * Sign in. Port of app/views/devise/sessions/new.html.erb.
 *
 * A server action rather than a client form: it keeps the password out of any
 * client bundle and needs no API route.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  const { callbackUrl, error } = await searchParams;

  if (session?.user) redirect(callbackUrl ?? "/admin");

  async function signInAction(formData: FormData) {
    "use server";

    const target = String(formData.get("callbackUrl") ?? "") || "/admin";

    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: target,
      });
    } catch (thrown) {
      // next-auth signals a successful redirect by throwing NEXT_REDIRECT, so
      // it has to be re-thrown rather than reported as a failed sign-in.
      if (
        thrown &&
        typeof thrown === "object" &&
        "digest" in thrown &&
        String((thrown as { digest?: unknown }).digest).startsWith(
          "NEXT_REDIRECT",
        )
      ) {
        throw thrown;
      }
      // Every failure reads the same to the visitor, matching Devise's
      // `paranoid` intent: a wrong email and a wrong password are not
      // distinguishable.
      redirect(
        `/login?error=invalid&callbackUrl=${encodeURIComponent(target)}`,
      );
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-slate-800">
      <div className="w-96 rounded-lg bg-white p-4">
        <h2 className="mb-4 text-2xl font-bold text-slate-800">Sign in</h2>

        {error ? (
          <p className="mb-3 text-sm text-orange-600">
            Invalid email or password.
          </p>
        ) : null}

        <form action={signInAction}>
          <input type="hidden" name="callbackUrl" value={callbackUrl ?? ""} />

          <label
            htmlFor="email"
            className="block text-sm/6 font-medium text-slate-800"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="w-full rounded-md bg-slate-200 p-2"
          />

          <label
            htmlFor="password"
            className="mt-2 block text-sm/6 font-medium text-slate-800"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="w-full rounded-md bg-slate-200 p-2"
          />

          <div className="mt-4">
            <button
              type="submit"
              className="rounded-md bg-slate-600 px-3 py-1 text-white shadow-sm hover:bg-slate-700"
            >
              Sign In
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
