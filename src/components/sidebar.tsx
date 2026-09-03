import Link from "next/link";

/** Port of app/views/shared/_sidebar.html.erb. */
const LINKS = [
  { href: "/admin", label: "Home" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/users", label: "Users" },
  // No Callbacks screen: this droplet has no `callbacks` table. Its one
  // callback is declared in src/lib/config/droplet.config.ts.
] as const;

export function Sidebar() {
  return (
    <nav className="flex min-h-0 w-48 flex-col gap-2 overflow-auto">
      <div className="relative flex w-full min-w-0 flex-col p-4">
        <div className="flex h-8 text-xs font-medium" />
        <ul className="flex w-full min-w-0 flex-col gap-1">
          {LINKS.map((link) => (
            <li key={link.href} className="relative">
              <Link
                href={link.href}
                className="flex items-center rounded-md px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
