/**
 * User administration.
 *
 * Port of Admin::UsersController plus the parts of the Devise User model this
 * app still needs. Devise's own validations (`:validatable`) are reimplemented
 * here because the app no longer has them: email present, unique and
 * well-formed; password at least `config.password_length.min` characters and
 * matching its confirmation.
 */

import { prisma } from "@/lib/db";
import { hashPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { sanitizePermissionSets } from "@/lib/permissions";

export interface UserInput {
  email: string;
  password?: string;
  passwordConfirmation?: string;
  permissionSets: string[];
}

export type UserResult =
  | { ok: true; id: bigint }
  | { ok: false; errors: string[] };

/** Devise's `case_insensitive_keys` / `strip_whitespace_keys` both list :email. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function validate(
  input: UserInput,
  { requirePassword }: { requirePassword: boolean },
  excludeId?: bigint,
): Promise<string[]> {
  const errors: string[] = [];
  const email = normalizeEmail(input.email);

  if (!email) {
    errors.push("Email can't be blank");
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.push("Email is invalid");
  } else {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== excludeId) {
      errors.push("Email has already been taken");
    }
  }

  const password = input.password ?? "";
  if (requirePassword || password.length > 0) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.push(
        `Password is too short (minimum is ${MIN_PASSWORD_LENGTH} characters)`,
      );
    }
    if (password !== (input.passwordConfirmation ?? "")) {
      errors.push("Password confirmation doesn't match Password");
    }
  }

  return errors;
}

export async function createUser(input: UserInput): Promise<UserResult> {
  const errors = await validate(input, { requirePassword: true });
  if (errors.length > 0) return { ok: false, errors };

  const user = await prisma.user.create({
    data: {
      email: normalizeEmail(input.email),
      encryptedPassword: await hashPassword(input.password ?? ""),
      permissionSets: sanitizePermissionSets(input.permissionSets),
    },
  });

  return { ok: true, id: user.id };
}

/**
 * Updates a user.
 *
 * A blank password leaves the digest alone — the same behaviour as the Rails
 * controller, which deleted :password and :password_confirmation from the
 * params when both were blank.
 */
export async function updateUser(
  id: bigint,
  input: UserInput,
): Promise<UserResult> {
  const errors = await validate(input, { requirePassword: false }, id);
  if (errors.length > 0) return { ok: false, errors };

  await prisma.user.update({
    where: { id },
    data: {
      email: normalizeEmail(input.email),
      permissionSets: sanitizePermissionSets(input.permissionSets),
      ...(input.password
        ? { encryptedPassword: await hashPassword(input.password) }
        : {}),
    },
  });

  return { ok: true, id };
}

export async function deleteUser(id: bigint): Promise<void> {
  await prisma.user.delete({ where: { id } });
}

/** Reads a form post into a UserInput. */
export function userInputFrom(formData: FormData): UserInput {
  return {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    passwordConfirmation: String(formData.get("password_confirmation") ?? ""),
    permissionSets: formData.getAll("permission_sets").map(String),
  };
}
