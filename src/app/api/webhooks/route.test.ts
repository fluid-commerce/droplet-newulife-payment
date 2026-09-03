/**
 * Webhook route.
 *
 * The opposite policy to a callback: this is not the checkout path, so an
 * unverified request is refused loudly with a 401 and nothing runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { companyFixture } from "@/test/factories";
import { signedWebhookRequest } from "@/test/signing";

const mockPrisma = vi.hoisted(() => ({
  company: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  fluidCallbackRegistration: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
}));

const handleInstalled = vi.hoisted(() => vi.fn(async () => {}));
const handleUninstalled = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/handlers/droplet-installed", () => ({
  handleDropletInstalled: handleInstalled,
}));
vi.mock("@/lib/handlers/droplet-uninstalled", () => ({
  handleDropletUninstalled: handleUninstalled,
}));

const { POST } = await import("./route");

const BOOTSTRAP = "test-webhook-token";

const installBody = {
  resource: "droplet",
  event: "installed",
  company: {
    fluid_shop: "acme.fluid.app",
    name: "Acme",
    fluid_company_id: 42,
    droplet_uuid: "drp_test",
    droplet_installation_uuid: "dri_acme",
    authentication_token: "cat_acme",
    webhook_verification_token: "wvt_acme",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findFirst.mockResolvedValue(null);
});

describe("POST /api/webhooks", () => {
  it("accepts droplet.installed signed with the shared bootstrap secret", async () => {
    const response = await POST(
      signedWebhookRequest({ secret: BOOTSTRAP, body: installBody }),
    );

    expect(response.status).toBe(202);
    expect(handleInstalled).toHaveBeenCalledOnce();
  });

  it("refuses droplet.installed signed with the wrong secret", async () => {
    const response = await POST(
      signedWebhookRequest({ secret: "not-the-token", body: installBody }),
    );

    expect(response.status).toBe(401);
    expect(handleInstalled).not.toHaveBeenCalled();
  });

  it("refuses an unsigned request", async () => {
    const response = await POST(
      new Request("https://droplet.test/api/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(installBody),
      }),
    );

    expect(response.status).toBe(401);
    expect(handleInstalled).not.toHaveBeenCalled();
  });

  it("will not let the bootstrap secret authenticate a non-lifecycle event", async () => {
    // This is the hole the Rails controller had: any caller holding the shared
    // AUTH_TOKEN could send a webhook about any company.
    mockPrisma.company.findFirst.mockResolvedValue(companyFixture());

    const response = await POST(
      signedWebhookRequest({
        secret: BOOTSTRAP,
        body: {
          resource: "order",
          event: "created",
          company: { droplet_installation_uuid: "dri_acme" },
        },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("accepts a company event signed with that company's own token", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyFixture());

    const response = await POST(
      signedWebhookRequest({
        secret: "wvt_acme",
        body: {
          resource: "order",
          event: "created",
          company: { droplet_installation_uuid: "dri_acme" },
        },
      }),
    );

    // Verified, but no handler is registered for order.created by default, so
    // 204 — which is what Rails answered when EventHandler found no handler.
    expect(response.status).toBe(204);
  });

  it("answers 500 when a handler throws, so Fluid retries", async () => {
    handleInstalled.mockRejectedValueOnce(new Error("database down"));

    const response = await POST(
      signedWebhookRequest({ secret: BOOTSTRAP, body: installBody }),
    );

    expect(response.status).toBe(500);
  });

  it("refuses a replayed signature that is older than the freshness window", async () => {
    const response = await POST(
      signedWebhookRequest({
        secret: BOOTSTRAP,
        body: installBody,
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      }),
    );

    expect(response.status).toBe(401);
  });
});
