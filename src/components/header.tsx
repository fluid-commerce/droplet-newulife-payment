import { signOut } from "@/auth";

/** Port of app/views/shared/_header.html.erb. */
export function Header({ email }: { email: string | null | undefined }) {
  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <header className="flex h-8 w-full shrink-0 items-center px-8 transition-[width,height] ease-linear">
      <div className="flex-1" />
      <span className="mr-4 text-sm text-gray-600">{email}</span>
      <form action={signOutAction}>
        <button
          type="submit"
          className="text-sm text-blue-600 hover:text-orange-600"
        >
          Sign out
        </button>
      </form>
    </header>
  );
}
