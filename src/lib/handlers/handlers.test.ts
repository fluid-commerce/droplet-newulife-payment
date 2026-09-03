/**
 * Install and uninstall handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { companyFixture } from "@/test/factories";

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

const registerCallbacksForCompany = vi.hoisted(() =>
  vi.fn(async () => ({
    success: 1,
    failed: 0,
    registeredUuids: ["cbr_1"],
    errors: [],
  })),
);
const cleanupCallbacksForCompany = vi.hoisted(() => vi.fn(async () => {}));
const deleteForInstallation = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/callbacks", () => ({
  registerCallbacksForCompany,
  cleanupCallbacksForCompany,
  callbackStore: {
    findByTokenDigest: vi.fn(async () => null),
    upsert: vi.fn(async () => {}),
    deleteForInstallation,
  },
}));
vi.mock("@/lib/settings", () => ({
  dropletSettings: vi.fn(async () => ({
    name: "Template",
    embed_url: null,
    uuid: "drp_test",
    active: true,
  })),
}));
vi.mock("@/lib/config", () => ({
  dropletConfig: { webhooks: [] },
  registerAllFeatures: vi.fn(async () => ({
    webhooks: { success: 0, failed: 0, errors: [] },
  })),
  cleanupAllFeatures: vi.fn(async () => ({
    webhooks: { success: 0, failed: 0 },
  })),
}));

const { handleDropletInstalled } = await import("./droplet-installed");
const { handleDropletUninstalled } = await import("./droplet-uninstalled");

const installPayload = {
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
  mockPrisma.company.create.mockResolvedValue(companyFixture());
  mockPrisma.company.update.mockResolvedValue(companyFixture());
  registerCallbacksForCompany.mockResolvedValue({
    success: 1,
    failed: 0,
    registeredUuids: ["cbr_1"],
    errors: [],
  });
});

describe("handleDropletInstalled", () => {
  it("creates the company and registers its active callbacks", async () => {
    await handleDropletInstalled(installPayload);

    expect(mockPrisma.company.create).toHaveBeenCalledOnce();
    const created = mockPrisma.company.create.mock.calls[0][0].data;
    expect(created.fluidShop).toBe("acme.fluid.app");
    // db/schema.rb types this bigint, and Rails wrote it as one.
    expect(created.fluidCompanyId).toBe(42n);
    expect(created.companyDropletUuid).toBe("drp_test");

    expect(registerCallbacksForCompany).toHaveBeenCalledWith(
      expect.anything(),
      "dri_acme",
    );
  });

  it("updates the existing row rather than duplicating it", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyFixture());

    await handleDropletInstalled(installPayload);

    expect(mockPrisma.company.create).not.toHaveBeenCalled();
    expect(mockPrisma.company.update).toHaveBeenCalled();
  });

  it("clears uninstalled_at, so a reinstall is live again", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      companyFixture({ uninstalledAt: new Date(), active: false }),
    );

    await handleDropletInstalled(installPayload);

    const update = mockPrisma.company.update.mock.calls[0][0];
    expect(update.data.uninstalledAt).toBeNull();
    expect(update.data.active).toBe(true);
  });

  it("clears stale callback digests before re-registering", async () => {
    // Otherwise a reinstall leaves rows pointing at tokens Fluid no longer
    // holds, and a genuine request verifies against nothing.
    await handleDropletInstalled(installPayload);
    expect(deleteForInstallation).toHaveBeenCalledWith("dri_acme");
  });

  it("ignores an install event for a different droplet", async () => {
    await handleDropletInstalled({
      company: { ...installPayload.company, droplet_uuid: "drp_someone_else" },
    });

    expect(mockPrisma.company.create).not.toHaveBeenCalled();
    expect(registerCallbacksForCompany).not.toHaveBeenCalled();
  });

  it("rejects a payload with no authentication token", async () => {
    const { authentication_token: _omitted, ...rest } = installPayload.company;
    await expect(handleDropletInstalled({ company: rest })).rejects.toThrow();
  });
});

describe("handleDropletUninstalled", () => {
  it("deletes the recorded registrations and marks the row uninstalled", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyFixture());

    await handleDropletUninstalled({
      company: { fluid_company_id: 42, droplet_installation_uuid: "dri_acme" },
    });

    // The uuids to delete come from fluid_callback_registrations keyed on the
    // dri, so the handler passes the dri and nothing else.
    expect(cleanupCallbacksForCompany).toHaveBeenCalledWith(
      expect.anything(),
      "dri_acme",
    );

    const update = mockPrisma.company.update.mock.calls.at(-1)![0];
    expect(update.data.active).toBe(false);
    expect(update.data.uninstalledAt).toBeInstanceOf(Date);
  });

  it("does nothing when no company matches", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    await handleDropletUninstalled({
      company: { fluid_company_id: 999 },
    });

    expect(cleanupCallbacksForCompany).not.toHaveBeenCalled();
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });
});
