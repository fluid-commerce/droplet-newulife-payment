/**
 * Vitest setup.
 *
 * The environment is assigned at module scope, NOT inside `beforeAll`. Route
 * modules read configuration such as FLUID_WEBHOOK_AUTH_TOKEN once, when they
 * are imported — a test file's top-level `await import("./route")` runs before
 * any `beforeAll` hook fires, so setting them there would leave the route
 * holding undefined and every signed request would be refused.
 */

import { afterAll, beforeEach, afterEach, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://test:test@localhost:5432/droplet_newulife_payment_test";
process.env.FLUID_API_URL = "https://api.fluid.test";
process.env.FLUID_WEBHOOK_AUTH_TOKEN = "test-webhook-token";
process.env.FLUID_DROPLET_URL = "https://droplet.test";
process.env.DROPLET_UUID = "drp_test";
process.env.AUTH_SECRET = "test-auth-secret";

afterAll(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});
