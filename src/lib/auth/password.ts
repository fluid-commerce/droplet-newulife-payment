/**
 * Password hashing, compatible with the Devise rows already in `users`.
 *
 * Devise's `database_authenticatable` stores a bcrypt digest in
 * `encrypted_password` and compares with
 * `BCrypt::Password.new(encrypted_password) == "#{password}#{pepper}"`.
 *
 * `config.pepper` is commented out in config/initializers/devise.rb, so the
 * pepper is nil and the digest is a plain bcrypt hash of the password with no
 * suffix. That is why Auth.js can verify these rows directly and why the
 * migration needs no password reset. If a fork of this template ever sets a
 * pepper, this file is the only place that has to know.
 *
 * bcryptjs is pinned to 2.x because it emits `$2a$` digests, the same prefix
 * bcrypt-ruby writes. Both apps can then read each other's rows while they run
 * side by side.
 */

import bcrypt from "bcryptjs";

/** Devise's `config.stretches` outside the test environment. */
export const BCRYPT_COST = 12;

/** Devise's `config.password_length` lower bound. */
export const MIN_PASSWORD_LENGTH = 6;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(
  password: string,
  encryptedPassword: string,
): Promise<boolean> {
  // A blank digest is the Rails column default: a row that never had a password
  // set. bcrypt.compare would return false anyway; returning early makes it
  // explicit that this is not an authentication path.
  if (!encryptedPassword) return false;

  try {
    return await bcrypt.compare(password, encryptedPassword);
  } catch {
    // A malformed digest is a data problem, not a credential match.
    return false;
  }
}
