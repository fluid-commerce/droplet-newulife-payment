import { describe, it, expect } from "vitest";

import {
  can,
  hasPermissionSet,
  sanitizePermissionSets,
  PERMISSION_SET_NAMES,
} from "./index";

describe("can", () => {
  it("grants everything to AdminPermissions, as `can :manage, :all` did", () => {
    const admin = { permissionSets: ["AdminPermissions"] };
    expect(can(admin, "manage", "all")).toBe(true);
    expect(can(admin, "destroy", "User")).toBe(true);
    expect(can(admin, "read", "Setting")).toBe(true);
  });

  it("grants nothing to a user with no permission sets", () => {
    expect(can({ permissionSets: [] }, "read", "Dashboard")).toBe(false);
  });

  it("grants nothing for a null user, as `Ability.new(user: nil)` did", () => {
    expect(can(null, "read", "Dashboard")).toBe(false);
  });

  it("ignores a permission set name this app does not define", () => {
    // Rails' `safe_constantize&.apply` returned nil for an unknown class rather
    // than raising, and the row silently granted nothing. Kept, because rows
    // naming a set that has been removed still exist in a live database.
    expect(can({ permissionSets: ["GhostPermissions"] }, "read", "User")).toBe(
      false,
    );
  });
});

describe("hasPermissionSet", () => {
  it("matches User#has_permission_set?", () => {
    const user = { permissionSets: ["AdminPermissions"] };
    expect(hasPermissionSet(user, "AdminPermissions")).toBe(true);
    expect(hasPermissionSet(user, "Other")).toBe(false);
    expect(hasPermissionSet(null, "AdminPermissions")).toBe(false);
  });
});

describe("sanitizePermissionSets", () => {
  it("drops names this app does not define", () => {
    // Port of `permitted[:permission_sets] &= PermissionSet.descendants...`.
    // Without it a crafted form post writes any string into the array.
    expect(
      sanitizePermissionSets(["AdminPermissions", "SuperAdmin", 7, null]),
    ).toEqual(["AdminPermissions"]);
  });

  it("returns an empty array for anything that is not an array", () => {
    expect(sanitizePermissionSets(undefined)).toEqual([]);
    expect(sanitizePermissionSets("AdminPermissions")).toEqual([]);
  });

  it("offers AdminPermissions in the admin UI", () => {
    expect(PERMISSION_SET_NAMES).toContain("AdminPermissions");
  });
});
