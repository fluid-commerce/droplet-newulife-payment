/**
 * The Devise rows already in `users` must keep working, unchanged.
 *
 * Devise's `database_authenticatable` writes
 * `BCrypt::Password.create("#{password}#{pepper}", cost: stretches)`. In this
 * app `config.stretches = 12` and `config.pepper` is commented out, so the
 * pepper is nil and `encrypted_password` is a plain bcrypt digest of the
 * password with nothing appended. That is the whole reason no password reset is
 * needed to migrate.
 */

import { describe, it, expect } from "vitest";

import { hashPassword, verifyPassword, BCRYPT_COST } from "./password";

/**
 * Produced by bcrypt-ruby (the gem Devise uses) for the password "sekrit123":
 *
 *   ruby -e 'require "bcrypt"; puts BCrypt::Password.create("sekrit123", cost: 12)'
 *
 * i.e. byte-for-byte what Devise wrote into an existing production row.
 */
const DEVISE_DIGEST =
  "$2a$12$6vJJSI225jYek3NWKULHTu0HnaulM534ps8TRWxDXOasc/eh5b5c.";

/**
 * The other direction: a digest this app produced, which bcrypt-ruby accepts —
 * confirmed with
 *
 *   ruby -e 'require "bcrypt"; BCrypt::Password.new(<digest>) == "sekrit123"'  #=> true
 *
 * That matters because the Rails app and this one run against the same database
 * during the migration, so a user created or given a new password here must
 * still be able to sign in there.
 */
const BCRYPTJS_DIGEST =
  "$2a$12$zNtIUjIc/215eggHzOxSE.gGyo8ZbBd41XfQ1zfNlconvYL3sYGkW";

describe("verifyPassword", () => {
  it("verifies a digest written by Devise, with no reset needed", async () => {
    await expect(verifyPassword("sekrit123", DEVISE_DIGEST)).resolves.toBe(
      true,
    );
  });

  it("rejects the wrong password against a Devise digest", async () => {
    await expect(verifyPassword("wrong", DEVISE_DIGEST)).resolves.toBe(false);
  });

  it("rejects a blank digest, which is the Rails column default", async () => {
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
  });

  it("rejects rather than throws on a malformed digest", async () => {
    await expect(verifyPassword("anything", "not-a-bcrypt-hash")).resolves.toBe(
      false,
    );
  });
});

describe("hashPassword", () => {
  it("writes a $2a$ digest at Devise's cost, so bcrypt-ruby can still read it", async () => {
    const digest = await hashPassword("sekrit123");
    expect(digest.startsWith(`$2a$${BCRYPT_COST}$`)).toBe(true);
    await expect(verifyPassword("sekrit123", digest)).resolves.toBe(true);
  });

  it("still verifies the recorded bcryptjs digest bcrypt-ruby accepted", async () => {
    // Pins the format, so a bcryptjs upgrade that switched to $2b$ — which
    // older bcrypt-ruby will not read — fails here rather than in production.
    expect(BCRYPTJS_DIGEST.startsWith("$2a$12$")).toBe(true);
    await expect(verifyPassword("sekrit123", BCRYPTJS_DIGEST)).resolves.toBe(
      true,
    );
  });
});
