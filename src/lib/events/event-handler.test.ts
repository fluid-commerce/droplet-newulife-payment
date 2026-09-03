import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  registerHandler,
  routeEvent,
  hasHandler,
  resetHandlers,
} from "./event-handler";

beforeEach(() => {
  resetHandlers();
});

describe("routeEvent", () => {
  it("routes to the handler registered for the event type", async () => {
    const handler = vi.fn(async () => {});
    registerHandler("droplet.installed", handler);

    await expect(routeEvent("droplet.installed", { a: 1 })).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });

  it("prefers a versioned handler and falls back to the unversioned one", async () => {
    const v1 = vi.fn(async () => {});
    const plain = vi.fn(async () => {});
    registerHandler("order.created", plain);
    registerHandler("order.created", v1, "v1");

    await routeEvent("order.created", {}, "v1");
    expect(v1).toHaveBeenCalledOnce();
    expect(plain).not.toHaveBeenCalled();

    await routeEvent("order.created", {}, "v9");
    expect(plain).toHaveBeenCalledOnce();
  });

  it("returns false when nothing is registered", async () => {
    await expect(routeEvent("nothing.here", {})).resolves.toBe(false);
  });

  it("propagates a handler error so the route can answer 500", async () => {
    // Rails swallowed this and returned false, which meant a failed job looked
    // identical to an unroutable event and Fluid never retried.
    registerHandler("droplet.installed", async () => {
      throw new Error("database down");
    });

    await expect(routeEvent("droplet.installed", {})).rejects.toThrow(
      "database down",
    );
  });
});

describe("hasHandler", () => {
  it("reports registration without running anything", () => {
    registerHandler("droplet.installed", async () => {});
    expect(hasHandler("droplet.installed")).toBe(true);
    expect(hasHandler("order.created")).toBe(false);
  });
});
