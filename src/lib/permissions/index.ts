/**
 * Permissions
 *
 * Port of app/permissions/{ability,permission_set,admin_permissions}.rb.
 *
 * CanCanCan built an Ability by asking each of the user's permission sets to
 * add rules to it; `can?(:action, subject)` then matched a request against
 * those rules. The shape here is the same, minus the metaprogramming: a
 * permission set is an entry in PERMISSION_SETS, and `can()` asks each of the
 * user's sets whether it allows the action.
 *
 * `users.permission_sets` holds the Ruby class names ("AdminPermissions"), and
 * this keeps reading them, so existing rows work unchanged. A name that is no
 * longer defined grants nothing — the same as `safe_constantize` returning nil.
 */

export type Action = "manage" | "read" | "create" | "update" | "destroy";

/** Every admin surface a rule can be written about. */
export type Subject =
  | "all"
  | "Dashboard"
  | "Setting"
  | "User"
  | "Callback"
  | "Droplet";

export interface PermissionSet {
  name: string;
  description: string;
  allows: (action: Action, subject: Subject) => boolean;
}

/**
 * Rails: `class AdminPermissions < PermissionSet` with `can :manage, :all`.
 */
const adminPermissions: PermissionSet = {
  name: "AdminPermissions",
  description: "Full access to every admin surface",
  allows: () => true,
};

export const PERMISSION_SETS: PermissionSet[] = [adminPermissions];

export const PERMISSION_SET_NAMES = PERMISSION_SETS.map((set) => set.name);

export interface PermissionSubject {
  permissionSets: string[];
}

/**
 * Whether `user` may perform `action` on `subject`.
 *
 * A null user is treated as `User.new` was in Rails: no permission sets, so no.
 */
export function can(
  user: PermissionSubject | null | undefined,
  action: Action,
  subject: Subject,
): boolean {
  if (!user) return false;

  return user.permissionSets.some((name) => {
    const set = PERMISSION_SETS.find((candidate) => candidate.name === name);
    // Unknown name: grants nothing, matching `safe_constantize&.apply`.
    return set ? set.allows(action, subject) : false;
  });
}

/** Rails: `User#has_permission_set?`. */
export function hasPermissionSet(
  user: PermissionSubject | null | undefined,
  name: string,
): boolean {
  return Boolean(user?.permissionSets.includes(name));
}

/**
 * Keeps only names this app actually defines.
 *
 * Port of the `permitted[:permission_sets] &= PermissionSet.descendants...`
 * line in Admin::UsersController — without it, a crafted form post can write
 * any string into the array.
 */
export function sanitizePermissionSets(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  return names.filter(
    (name): name is string =>
      typeof name === "string" && PERMISSION_SET_NAMES.includes(name),
  );
}
