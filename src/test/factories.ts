/**
 * Test fixtures.
 *
 * Shaped like the Prisma rows, BigInt ids included, so a test that gets them
 * wrong fails here rather than in production.
 */

export function companyFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    fluidShop: "acme.fluid.app",
    authenticationToken: "cat_acme",
    name: "Acme",
    settings: {},
    webhookVerificationToken: "wvt_acme",
    fluidCompanyId: 42n,
    serviceCompanyId: null,
    companyDropletUuid: "drp_test",
    active: true,
    uninstalledAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    dropletInstallationUuid: "dri_acme",
    ...overrides,
  };
}

export function registrationFixture(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "cbr_acme",
    dri: "dri_acme",
    definitionName: "redirect_cart_payment",
    tokenDigest: "unset",
    url: "https://droplet.test/api/callbacks/redirect-cart-payment",
    ...overrides,
  };
}
