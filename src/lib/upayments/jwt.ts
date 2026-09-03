/**
 * RS512 JWTs for the uPayments APIs.
 *
 * Port of the `generate_jwt_token` / `load_private_key_from_env` pair that
 * appears identically in app/services/u_payments_user_api_client.rb and
 * app/services/u_payments_checkout_api_client.rb.
 *
 * Signed with node:crypto rather than a JWT library, deliberately: the whole
 * job is one `RSA-SHA512` signature over `base64url(header).base64url(payload)`,
 * and doing it here means the emitted bytes can be compared against Ruby's
 * without depending on a second library's defaults.
 *
 * The header is exactly `{"alg":"RS512"}` — no `typ`. That is what ruby-jwt
 * 2.10 emits: `JWT::Token#header` starts from the caller's headers (empty here)
 * and only `alg` is added. Adding `typ` would be harmless for any conforming
 * verifier but would stop the two implementations being byte-comparable, which
 * is the property this port is trying to keep.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/** How long a token is valid for. Rails: `current_time + 3600`. */
export const TOKEN_TTL_SECONDS = 3600;

/** Rails: the hardcoded `iss` claim, misspelling included. */
export const JWT_ISSUER = "moola-buisness";

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Reads a PEM private key out of an environment variable.
 *
 * Cloud Run environment values cannot contain real newlines when they are set
 * through some of the tooling, so Rails replaced a literal `\n` with a real
 * one before parsing. Kept — a key set either way has to keep working.
 *
 * Throws with the variable's NAME and never its value.
 */
export function loadPrivateKey(envName: string): KeyObject {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`${envName} not found in environment variables`);
  }

  try {
    return createPrivateKey(raw.replace(/\\n/g, "\n"));
  } catch (error) {
    throw new Error(
      `Invalid private key format in ${envName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function requireEnv(envName: string): string {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`${envName} not found in environment variables`);
  }
  return value;
}

/**
 * Builds the `Token <jwt>` value the uPayments APIs expect.
 *
 * `now` is injectable so a test can assert the exact bytes rather than only
 * that something was produced.
 */
export function generateJwt({
  privateKey,
  apiCode,
  now = Math.floor(Date.now() / 1000),
}: {
  privateKey: KeyObject;
  apiCode: string;
  now?: number;
}): string {
  const header = base64url(JSON.stringify({ alg: "RS512" }));
  const payload = base64url(
    JSON.stringify({
      sub: apiCode,
      iss: JWT_ISSUER,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA512")
    .update(signingInput)
    .sign(privateKey);

  return `${signingInput}.${base64url(signature)}`;
}
