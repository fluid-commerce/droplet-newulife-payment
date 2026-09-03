/**
 * Builds requests signed the way Fluid signs them.
 *
 * Fluid HMACs `{timestamp}.{body}` with SHA-256. For a callback the key is that
 * registration's own `cvt_` verification token; for a webhook it is the
 * company's `webhook_verification_token`, or the shared bootstrap token on an
 * install.
 *
 * These build a real `Request`. A stub that only implements `json()` never
 * reaches the handler at all — the SDK reads the raw bytes, because
 * re-serialising a parsed object does not reproduce what was signed.
 */

import { createHmac } from "node:crypto";

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf8")
    .update(Buffer.from(body, "utf8"))
    .digest("hex");
}

export function signedCallbackRequest({
  url = "https://droplet.test/api/callbacks/redirect-cart-payment",
  token,
  body,
  signingToken,
  timestamp = Math.floor(Date.now() / 1000),
}: {
  url?: string;
  token: string;
  body: unknown;
  /** Defaults to `token`; pass a different value to forge a bad signature. */
  signingToken?: string;
  timestamp?: number;
}): Request {
  const serialized = JSON.stringify(body);

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fluid-callback-token": token,
      "x-fluid-timestamp": String(timestamp),
      "x-fluid-signature": sign(signingToken ?? token, timestamp, serialized),
    },
    body: serialized,
  });
}

export function signedWebhookRequest({
  url = "https://droplet.test/api/webhooks",
  secret,
  body,
  timestamp = Math.floor(Date.now() / 1000),
  headers = {},
}: {
  url?: string;
  secret: string;
  body: unknown;
  timestamp?: number;
  headers?: Record<string, string>;
}): Request {
  const serialized = JSON.stringify(body);

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fluid-timestamp": String(timestamp),
      "x-fluid-signature": sign(secret, timestamp, serialized),
      ...headers,
    },
    body: serialized,
  });
}
