/**
 * Safe summarisation for logging.
 *
 * The rule this package enforces: a request body never reaches a log line.
 * Fluid install payloads carry `authentication_token` and
 * `webhook_verification_token`, and cart payloads carry customer PII, so
 * neither belongs in a log.
 *
 * This can only be guaranteed for logging the package performs itself. A
 * handler that logs its own body is outside its reach.
 */

/** Keys whose values are replaced wherever they appear. */
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|credential|api[_-]?key|authorization|signature)/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

/**
 * Recursively replaces credential-shaped values.
 *
 * Deny-by-name rather than deny-by-value: matching on the key is stable, while
 * matching on the value is how redaction helpers silently stop working (a
 * helper testing values for the substring "password" never fires on a license
 * key).
 */
export function redactValue(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (input === null || input === undefined) return input;

  if (Array.isArray(input)) {
    return input.map((entry) => redactValue(entry, depth + 1));
  }

  if (typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValue(value, depth + 1);
    }
    return output;
  }

  return input;
}

/**
 * Renders an error for logging without leaking a body through its message.
 *
 * Truncation alone is not enough: upstream clients routinely embed whole
 * response bodies in error messages, and the first 300 characters of a cart
 * payload is still a cart payload. Anything resembling a JSON object or a
 * credential is stripped before truncating.
 */
export function describeError(error: unknown): {
  name: string;
  message: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  return { name, message: truncate(scrubMessage(raw), 300) };
}

/** Strips embedded JSON structures and credential-shaped tokens from free text. */
function scrubMessage(message: string): string {
  return (
    message
      // Any embedded object/array literal — the usual carrier for a body.
      .replace(/[{[][\s\S]*[}\]]/g, "[STRUCTURED_CONTENT_REMOVED]")
      // Fluid credential prefixes: cvt_, wvt_, dit_, dri_, drp_, cbr_.
      .replace(/\b(?:cvt|wvt|dit|dri|drp|cbr)_[A-Za-z0-9._-]+/g, "[REDACTED]")
      // key=value / key: value pairs whose key looks sensitive.
      .replace(
        /\b(token|secret|password|credential|api[_-]?key|authorization|signature)\b\s*[:=]\s*\S+/gi,
        "$1=[REDACTED]",
      )
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Injectable so droplets can route into Sentry or a structured logger later. */
export const consoleLogger: Logger = {
  info: (message, context) => console.log(message, context ?? {}),
  warn: (message, context) => console.warn(message, context ?? {}),
  error: (message, context) => console.error(message, context ?? {}),
};
