import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Maximum age of a signature, in seconds.
 *
 * Note this bounds *freshness*, not replay: the same request can be presented
 * repeatedly inside the window. There is no nonce or seen-signature cache.
 */
export const MAX_SIGNATURE_AGE_SECONDS = 300;

export type SignatureFailureReason =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "malformed_signature"
  | "no_secret"
  | "mismatch";

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: SignatureFailureReason; detail: string };

export interface VerifySignatureInput {
  /**
   * The exact bytes that were signed. Never a re-serialised object.
   *
   * Prefer the byte form. A string has already been through a UTF-8 decode,
   * which is not a round trip: `Request.text()` strips a leading BOM and turns
   * malformed sequences into U+FFFD, so re-encoding it here would not reproduce
   * what Fluid actually hashed.
   */
  rawBody: string | Uint8Array;
  signature: string | null;
  timestamp: string | null;
  /** The HMAC key. For callbacks this is the presented token; for webhooks the stored per-company token. */
  secret: string;
  maxAgeSeconds?: number;
  /** Injectable for tests. Seconds since epoch. */
  now?: () => number;
}

/**
 * Verifies an HMAC-SHA256 signature over `{timestamp}.{rawBody}`.
 *
 * This is the same computation Fluid performs for both webhooks
 * (`WebhookCaller`) and callbacks (`Callback::Client#generate_signed_headers`).
 * The two paths differ only in where the secret comes from.
 */
export function verifySignature({
  rawBody,
  signature,
  timestamp,
  secret,
  maxAgeSeconds = MAX_SIGNATURE_AGE_SECONDS,
  now = () => Math.floor(Date.now() / 1000),
}: VerifySignatureInput): SignatureResult {
  if (!signature) {
    return {
      valid: false,
      reason: "missing_signature",
      detail: "Missing X-Fluid-Signature header",
    };
  }

  if (!timestamp) {
    return {
      valid: false,
      reason: "missing_timestamp",
      detail: "Missing X-Fluid-Timestamp header",
    };
  }

  // Number() rather than parseInt: parseInt("123abc") silently yields 123.
  // Guard the blank/whitespace cases first — Number("") and Number("  ") are
  // both 0, an integer, which would sail past this check and surface as
  // `stale_timestamp` (1970) rather than as the malformed header it is.
  const timestampSeconds =
    timestamp.trim() === "" ? Number.NaN : Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) {
    return {
      valid: false,
      reason: "malformed_timestamp",
      detail: "X-Fluid-Timestamp is not an integer",
    };
  }

  const age = Math.abs(now() - timestampSeconds);
  if (age > maxAgeSeconds) {
    return {
      valid: false,
      reason: "stale_timestamp",
      detail: `Signature age ${age}s exceeds ${maxAgeSeconds}s`,
    };
  }

  // An empty secret would let anyone compute a matching HMAC. Never verify
  // against one — an unset stored token must fail closed, not authenticate.
  if (!secret) {
    return {
      valid: false,
      reason: "no_secret",
      detail: "No secret available to verify against",
    };
  }

  // Hash the prefix and the body as BYTES. Concatenating into a template string
  // would re-encode an already-decoded body; see the note on `rawBody`.
  const bodyBytes =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret)
    .update(Buffer.from(`${timestamp}.`, "utf8"))
    .update(bodyBytes)
    .digest("hex");

  // Validate the shape before parsing. `Buffer.from(s, "hex")` silently
  // truncates at the first invalid character rather than throwing, so
  // "<64 valid hex chars>zz" would otherwise parse to the same bytes as the
  // valid prefix and compare equal.
  if (!isHexOfLength(signature, expected.length)) {
    return {
      valid: false,
      reason: "malformed_signature",
      detail: "Signature is not hex of the expected length",
    };
  }

  const presented = Buffer.from(signature, "hex");
  const computed = Buffer.from(expected, "hex");

  if (presented.length !== computed.length || presented.length === 0) {
    return { valid: false, reason: "mismatch", detail: "Signature mismatch" };
  }

  if (!timingSafeEqual(presented, computed)) {
    return { valid: false, reason: "mismatch", detail: "Signature mismatch" };
  }

  return { valid: true };
}

/** True when `value` is exactly `length` lowercase-or-uppercase hex characters. */
function isHexOfLength(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Hashes a callback verification token for storage.
 *
 * Tokens are stored as digests so that a dump of a droplet's database does not
 * hand over working callback credentials. Fluid presents the plaintext token on
 * every request, so the digest is sufficient to locate the registration.
 */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
