/**
 * The dropzone page Fluid embeds in an iframe.
 *
 * Port of `EmbedController#index` and app/views/embed/*.html.erb, at the same
 * path (`GET /embed_ui?dri=...`). Fluid holds this url on the droplet record,
 * so keeping it identical means the dropzone moves with the host and nothing
 * else.
 *
 * The four states are the Ruby's four templates. Framing is allowed by the
 * `frame-ancestors` CSP in src/next.config.ts, which replaces Rails' cleared
 * X-Frame-Options.
 *
 * The three placeholder `href="#"` buttons in the ERB are dropped rather than
 * ported: they went nowhere, and a "Disconnect" button that does nothing on a
 * payments droplet is worse than no button.
 */

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function Panel({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn" | "error";
  title: string;
  children: React.ReactNode;
}) {
  const badge = {
    ok: "bg-green-100 text-green-600",
    warn: "bg-yellow-100 text-yellow-600",
    error: "bg-red-100 text-red-600",
  }[tone];

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-lg">
        <h1 className="mb-6 text-center text-xl font-semibold">
          NewULife Payment Redirect Integration
        </h1>
        <div className="text-center">
          <div
            className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full ${badge}`}
          >
            <span aria-hidden="true" className="text-lg font-bold">
              {tone === "ok" ? "✓" : tone === "warn" ? "!" : "×"}
            </span>
          </div>
          <h2 className="mb-2 text-lg font-medium">{title}</h2>
          <p className="mb-4 text-gray-600">{children}</p>
        </div>
        <div className="mt-6 text-center text-xs text-gray-500">
          &copy; {new Date().getFullYear()} Fluid Commerce
        </div>
      </div>
    </div>
  );
}

export default async function EmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ dri?: string }>;
}) {
  const { dri } = await searchParams;

  if (!dri) {
    return (
      <Panel tone="error" title="Missing Information">
        The company UUID parameter is missing. Please make sure the URL includes
        the <code>dri</code> (droplet_installation_uuid) parameter.
      </Panel>
    );
  }

  // findFirst, not findUnique: `droplet_installation_uuid` has no index at all
  // in this schema, let alone a unique one.
  const company = await prisma.company.findFirst({
    where: { dropletInstallationUuid: dri },
  });

  if (!company) {
    return (
      <Panel tone="error" title="Not Installed">
        The NewULife integration is not installed for this store.
      </Panel>
    );
  }

  if (company.uninstalledAt) {
    return (
      <Panel tone="warn" title="Service Uninstalled">
        The NewULife droplet service has been uninstalled. Uninstalled on:{" "}
        {company.uninstalledAt.toISOString().slice(0, 10)}
      </Panel>
    );
  }

  return (
    <Panel tone="ok" title="Connected">
      The NewULife droplet service is connected and working properly.
    </Panel>
  );
}
